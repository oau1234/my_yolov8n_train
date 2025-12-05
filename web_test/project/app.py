from flask import Flask, render_template, jsonify, request, url_for, Response
from ultralytics import YOLO
import cv2
import os
import uuid
import urllib.request
import numpy as np
import json

# Lấy đường dẫn tuyệt đối tới thư mục dự án
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
TEMPLATE_DIR = os.path.join(BASE_DIR, "templates")

# Khởi tạo Flask với đường dẫn template và static chuẩn
app = Flask(__name__, static_folder=STATIC_DIR, template_folder=TEMPLATE_DIR)

# Thư mục để lưu ảnh upload & ảnh xử lý
UPLOAD_FOLDER = os.path.join(STATIC_DIR, "uploads")
OUTPUT_FOLDER = os.path.join(STATIC_DIR, "outputs")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

# Lấy đường dẫn tuyệt đối tới model YOLO
model_path = os.path.join(BASE_DIR, "../../runs/detect/my_yolov8n_train_meme/weights/best.pt")

# Nếu đường dẫn tuyệt đối không tồn tại → dùng đường dẫn tương đối
if not os.path.exists(model_path):
    model_path = "runs/detect/my_yolov8n_train_meme/weights/best.pt"

# Load model YOLO
model = YOLO(model_path)

# Load danh sách class từ file classes.txt
classes_file = os.path.join(BASE_DIR, '..', '..', 'vehicle dataset', 'classes.txt')
if os.path.exists(classes_file):
    try:
        with open(classes_file, 'r', encoding='utf-8') as f:
            CLASS_NAMES = [line.strip() for line in f.readlines() if line.strip()]
    except Exception:
        CLASS_NAMES = []
else:
    CLASS_NAMES = []

@app.route("/")
def index():
    # Trả về giao diện chính + danh sách nhãn
    return render_template("index.html", class_names=CLASS_NAMES)

# ----------- CAMERA SETUP -----------

# Mở camera mặc định
camera = cv2.VideoCapture(0)

# Nếu camera lỗi → báo warning
if not camera.isOpened():
    print("[WARNING] Không mở được camera. Camera endpoints sẽ trả về lỗi.")
    camera = None

@app.route('/camera_status')
def camera_status():
    """
    Trả về thông tin camera để frontend kiểm tra xem camera có hoạt động hay không.
    """
    if camera is None:
        return jsonify({"ok": False, "error": "Camera not available"}), 500
    
    width = int(camera.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(camera.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    fps = float(camera.get(cv2.CAP_PROP_FPS) or 0.0)

    return jsonify({"ok": True, "width": width, "height": height, "fps": fps})

def gen_camera_frames():
    """
    Stream camera theo dạng MJPEG để hiển thị trực tiếp lên web.
    """
    if camera is None:
        yield b''
        return
    
    while True:
        ret, frame = camera.read()

        # Nếu không đọc được frame → skip
        if not ret or frame is None:
            continue
        
        # Encode ảnh sang JPG để truyền qua HTTP
        ret2, jpeg = cv2.imencode('.jpg', frame)
        if not ret2:
            continue

        # Gửi frame dạng stream
        yield (b'--frame\r\n'
            b'Content-Type: image/jpeg\r\n\r\n' + jpeg.tobytes() + b'\r\n')

@app.route('/camera_stream')
def camera_stream():
    # Endpoint để stream camera
    return Response(gen_camera_frames(),
                    mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route('/camera_capture', methods=['POST'])
def camera_capture():
    """
    Chụp 1 frame từ camera, chạy YOLO, lưu ảnh output và trả về JSON kết quả.
    """
    if camera is None:
        return jsonify({"error": "Camera not available"}), 500

    ret, frame = camera.read()
    if not ret or frame is None:
        return jsonify({"error": "Không chụp được khung từ camera"}), 500

    # Tạo tên file ngẫu nhiên
    timestamp = str(uuid.uuid4())[:8]
    filename = f"camera_{timestamp}.jpg"
    save_path = os.path.join(UPLOAD_FOLDER, filename)

    # Lưu ảnh chụp
    cv2.imwrite(save_path, frame)

    # Lấy thông số conf và iou từ frontend (tuỳ chọn)
    try:
        conf = float(request.args.get('conf', 0.5))
    except Exception:
        conf = 0.5
    try:
        iou = float(request.args.get('iou', 0.5))
    except Exception:
        iou = 0.5

    # Đọc lại ảnh vừa lưu
    img = cv2.imread(save_path)
    if img is None:
        return jsonify({"error": "Không thể đọc ảnh capture"}), 500

    # Chạy YOLO detect
    results = model(img, conf=conf, iou=iou)

    # Vẽ bounding box lên ảnh
    img_out = results[0].plot()

    # Lưu ảnh sau khi detect
    name_only = os.path.splitext(filename)[0]
    ext = os.path.splitext(filename)[1]
    output_filename = f"{name_only}_detect{ext}"
    output_path = os.path.join(OUTPUT_FOLDER, output_filename)
    cv2.imwrite(output_path, img_out)

    # Đếm số lượng từng loại đối tượng
    num_classes = len(CLASS_NAMES) if CLASS_NAMES else 6
    counts = [0] * num_classes

    try:
        boxes = results[0].boxes
        if hasattr(boxes, 'cls'):
            cls_vals = boxes.cls
            try:
                cls_arr = np.array(cls_vals).astype(int).flatten()
            except Exception:
                cls_arr = [int(x) for x in cls_vals]

            for c in cls_arr:
                if 0 <= int(c) < num_classes:
                    counts[int(c)] += 1
    except Exception:
        counts = [0] * num_classes

    # Tính thời gian đèn giao thông theo số lượng xe
    total_vehicles = sum(counts)

    if total_vehicles < 5:
        total_seconds = 20
    elif total_vehicles <= 10:
        total_seconds = 45
    elif total_vehicles <= 15:
        total_seconds = 60
    else:
        total_seconds = 90

    yellow_seconds = 3
    red_seconds = int(total_seconds)
    green_seconds = max(0, red_seconds - yellow_seconds)

    # Tạo URL để frontend hiển thị ảnh
    processed_url = url_for('static', filename=f"outputs/{output_filename}", _external=True)
    input_url = url_for('static', filename=f"uploads/{filename}", _external=True)

    return jsonify({
        "processed_image_url": processed_url,
        "input_image_url": input_url,
        "counts": counts,
        "total_seconds": total_seconds,
        "status": "ready",
        "red_seconds": red_seconds,
        "yellow_seconds": yellow_seconds,
        "green_seconds": green_seconds
    })

if __name__ == "__main__":
    # Chạy Flask server
    app.run(host="0.0.0.0", port=5000, debug=False)
