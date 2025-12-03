from flask import Flask, render_template, jsonify, request, url_for, Response
from ultralytics import YOLO
import cv2
import os
import uuid
import urllib.request
import numpy as np
import json

# -------------------------------------------------------------
# GHI CHÚ (Tiếng Việt):
# Đây là file chính của ứng dụng Flask.
# - Trình bày giao diện (templates) trong `templates/`
# - Tài nguyên tĩnh (CSS/JS/ảnh) trong `static/`
# - Upload ảnh từ client -> lưu vào `static/uploads/`
# - Chạy YOLO trên ảnh đó -> lưu ảnh đã vẽ bbox vào `static/outputs/`
# - Trả về JSON chứa đường dẫn ảnh đã xử lý, danh sách counts theo lớp,
#   tổng thời gian ước lượng và trạng thái đèn (ready/processing/error)
#
# Ghi chú khác:
# - Các hàm và khối chính được chú thích trực tiếp bên dưới.
# - Nếu muốn thay đổi tên class hoặc thứ tự, chỉnh file `vehicle dataset/classes.txt`.
# -------------------------------------------------------------

# Get the absolute path to the project directory
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
TEMPLATE_DIR = os.path.join(BASE_DIR, "templates")

app = Flask(__name__, static_folder=STATIC_DIR, template_folder=TEMPLATE_DIR)

# ===============================
# CẤU HÌNH FOLDER LƯU ẢNH (dùng static folder ứng dụng)
# ===============================
# Use the app's configured static folder so Flask can serve saved files
UPLOAD_FOLDER = os.path.join(STATIC_DIR, "uploads")
OUTPUT_FOLDER = os.path.join(STATIC_DIR, "outputs")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

# ===============================
# LOAD YOLO MODEL
# ===============================
# Use absolute path to model
model_path = os.path.join(BASE_DIR, "../../runs/detect/my_yolov8n_train_meme/weights/best.pt")
if not os.path.exists(model_path):
    model_path = "runs/detect/my_yolov8n_train_meme/weights/best.pt"
# Load class names from dataset if available
model = YOLO(model_path)
classes_file = os.path.join(BASE_DIR, '..', '..', 'vehicle dataset', 'classes.txt')
if os.path.exists(classes_file):
    try:
        with open(classes_file, 'r', encoding='utf-8') as f:
            CLASS_NAMES = [line.strip() for line in f.readlines() if line.strip()]
    except Exception:
        CLASS_NAMES = []
else:
    CLASS_NAMES = []

# ===============================
# ROUTE HTML CHÍNH
# ===============================
@app.route("/")
def index():
    # Pass class names to template for labeling the counts boxes
    return render_template("index.html", class_names=CLASS_NAMES)

# =========================================
# API UPLOAD ẢNH + XỬ LÝ YOLO
# =========================================
@app.route("/upload", methods=["POST"])
def upload():
    file = request.files.get("image")
    image_url = request.form.get("image_url", "").strip()

    # Không có ảnh
    if not file and not image_url:
        return jsonify({"error": "Chưa chọn file hoặc nhập URL"}), 400

    # Tạo tên file từ upload hoặc URL
    if file:
        # Lấy tên gốc từ file upload, loại bỏ ký tự đặc biệt
        original_filename = file.filename
        # Lấy phần tên + extension
        name_only = os.path.splitext(original_filename)[0]
        ext = os.path.splitext(original_filename)[1]
        if not ext:
            ext = ".jpg"
        # Tạo tên file upload với timestamp để tránh trùng lặp
        timestamp = str(uuid.uuid4())[:8]
        upload_filename = f"{name_only}_{timestamp}{ext}"
    else:
        # Nếu từ URL, tạo tên mặc định
        timestamp = str(uuid.uuid4())[:8]
        upload_filename = f"image_{timestamp}.jpg"
    
    upload_path = os.path.join(UPLOAD_FOLDER, upload_filename)

    # ==========================
    # 📌 Lưu ảnh upload hoặc URL
    # ==========================
    try:
        if file:
            file.save(upload_path)
        else:
            resp = urllib.request.urlopen(image_url)
            arr = np.frombuffer(resp.read(), np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            cv2.imwrite(upload_path, img)

    except Exception as e:
        return jsonify({"error": f"Không tải được ảnh: {e}"}), 400

    # ==========================
    # 📌 Chạy YOLO
    # ==========================
    img = cv2.imread(upload_path)
    if img is None:
        return jsonify({"error": "Không thể đọc ảnh upload"}), 400
    
    conf = float(request.form.get("conf", 0.5))
    iou  = float(request.form.get("iou", 0.5))

    results = model(img, conf=conf, iou=iou)

    # Kết quả YOLO vẽ sẵn bbox
    img_out = results[0].plot()
    
    # Tạo tên file output với suffix _detect
    name_only = os.path.splitext(upload_filename)[0]
    ext = os.path.splitext(upload_filename)[1]
    output_filename = f"{name_only}_detect{ext}"
    output_path = os.path.join(OUTPUT_FOLDER, output_filename)
    cv2.imwrite(output_path, img_out)
    
    # Verify output file was created
    if not os.path.exists(output_path):
        return jsonify({"error": "Không thể lưu ảnh xử lý"}), 500
    # ==========================
    # 📌 Tính số lượng theo lớp, thời gian và trạng thái
    # ==========================
    # Determine number of classes
    num_classes = len(CLASS_NAMES) if CLASS_NAMES else 6
    counts = [0] * num_classes
    try:
        boxes = results[0].boxes
        if hasattr(boxes, 'cls'):
            cls_vals = boxes.cls
            try:
                import numpy as _np
                cls_arr = _np.array(cls_vals).astype(int).flatten()
            except Exception:
                cls_arr = [int(x) for x in cls_vals]

            for c in cls_arr:
                if 0 <= int(c) < num_classes:
                    counts[int(c)] += 1
    except Exception:
        counts = [0] * num_classes

    # ====================================
    # TÍNH MẬT ĐỘ GIAO THÔNG
    # Tổng số xe -> áp dụng 4 mức độ:
    # < 5 xe: Ít (20s đỏ)
    # 5-10 xe: Trung bình (45s đỏ)
    # 10-15 xe: Khá (60s đỏ)
    # > 15 xe: Đông (90s đỏ)
    # ====================================
    total_vehicles = sum(counts)
    
    if total_vehicles < 5:
        total_seconds = 20  # Ít
    elif total_vehicles <= 10:
        total_seconds = 45  # Trung bình
    elif total_vehicles <= 15:
        total_seconds = 60  # Khá
    else:
        total_seconds = 90  # Đông

    # Compute traffic light durations
    yellow_seconds = 3
    red_seconds = int(total_seconds)
    green_seconds = max(0, red_seconds - yellow_seconds)

    # Determine status using red_seconds thresholds
    if red_seconds <= 30:
        status = 'ready'
    elif red_seconds <= 60:
        status = 'processing'
    else:
        status = 'error'

    # ==========================
    # 📌 Trả kết quả về JS (dùng url_for để đảm bảo URL static chính xác)
    # ==========================
    processed_url = url_for('static', filename=f"outputs/{output_filename}")
    input_url = url_for('static', filename=f"uploads/{upload_filename}")

    return jsonify({
        "processed_image_url": processed_url,
        "input_image_url": input_url,
        "counts": counts,
        "total_seconds": total_seconds,
        "status": status,
        "red_seconds": red_seconds,
        "yellow_seconds": yellow_seconds,
        "green_seconds": green_seconds
    })

# ===============================
# Chạy server
# ===============================
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)


# ===============================
# Camera stream and single-capture endpoints (for Raspberry Pi USB camera)
# - /camera_stream returns an MJPEG stream read from /dev/video0 (cv2.VideoCapture(0))
# - /camera_capture captures one frame, saves to uploads folder and returns its public URL
# Note: these endpoints access the local camera device on the server (suitable for Raspberry Pi)
# ===============================


@app.route('/camera_status')
def camera_status():
    """
    Endpoint chẩn đoán camera:
    - Trả về JSON cho biết có thể mở camera không, kích thước frame và fps.
    - Dùng để debug khi stream/capture không hoạt động trên Raspberry Pi.
    """
    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        return jsonify({"ok": False, "error": "Không mở được camera (cv2.VideoCapture(0) thất bại)"}), 500
    try:
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
    finally:
        cap.release()

    return jsonify({"ok": True, "width": width, "height": height, "fps": fps})


def gen_camera_frames(camera_index=0):
    cap = cv2.VideoCapture(camera_index)
    if not cap.isOpened():
        return
    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            ret2, jpeg = cv2.imencode('.jpg', frame)
            if not ret2:
                continue
            chunk = jpeg.tobytes()
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + chunk + b'\r\n')
    finally:
        cap.release()


@app.route('/camera_stream')
def camera_stream():
    return Response(gen_camera_frames(0), mimetype='multipart/x-mixed-replace; boundary=frame')


@app.route('/camera_capture', methods=['POST'])
def camera_capture():
    # Capture a single frame from the server camera and save to uploads
    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        return jsonify({"error": "Không mở được camera trên server"}), 500
    ret, frame = cap.read()
    cap.release()
    if not ret or frame is None:
        return jsonify({"error": "Không chụp được khung từ camera"}), 500

    # Save with unique name
    timestamp = str(uuid.uuid4())[:8]
    filename = f"camera_{timestamp}.jpg"
    save_path = os.path.join(UPLOAD_FOLDER, filename)
    try:
        cv2.imwrite(save_path, frame)
    except Exception as e:
        return jsonify({"error": f"Không lưu được ảnh: {e}"}), 500

    # Return full external URL so client or server can reuse it
    image_url = url_for('static', filename=f"uploads/{filename}", _external=True)
    return jsonify({"image_url": image_url})
