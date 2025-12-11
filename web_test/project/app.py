from flask import Flask, render_template, jsonify, request, url_for, Response
from ultralytics import YOLO
import cv2
import os
import uuid
import urllib.request
import numpy as np
import json
import threading
import time
import atexit
try:
    import serial
except ImportError:
    serial = None

# -------------------------------------------------------------------------
# CẤU HÌNH FLASK APP VÀ THƯ MỤC
# -------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
TEMPLATE_DIR = os.path.join(BASE_DIR, "templates")

#khởi tạo Flask app
app = Flask(__name__, static_folder=STATIC_DIR, template_folder=TEMPLATE_DIR)

# Thư mục chứa ảnh upload và ảnh output
UPLOAD_FOLDER = os.path.join(STATIC_DIR, "uploads")
OUTPUT_FOLDER = os.path.join(STATIC_DIR, "outputs")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
os.makedirs(OUTPUT_FOLDER, exist_ok=True)

# -------------------------------------------------------------------------
# LOAD MODEL YOLO
# -------------------------------------------------------------------------

# Lấy đường dẫn tuyệt đối của model YOLO
model_path = os.path.join(BASE_DIR, "../../runs/detect/my_yolov8n_train_meme/weights/best.pt")
# Nếu đường dẫn tuyệt đối không tồn tại → dùng đường dẫn tương đối
if not os.path.exists(model_path):
    model_path = "runs/detect/my_yolov8n_train_meme/weights/best.pt"
# Load model YOLO vào RAM (mất thời gian 1 lần duy nhất)
model = YOLO(model_path)

# -------------------------------------------------------------------------
# LOAD DANH SÁCH CLASS TỪ FILE classes.txt
# -------------------------------------------------------------------------
classes_file = os.path.join(BASE_DIR, '..', '..', 'vehicle dataset', 'classes.txt')
if os.path.exists(classes_file):
    try:
        with open(classes_file, 'r', encoding='utf-8') as f:
            CLASS_NAMES = [line.strip() for line in f.readlines() if line.strip()]
    except Exception:
        CLASS_NAMES = []
else:
    CLASS_NAMES = []
#=================================
#=====Module Detect Frame ========
#=================================
def detect_frame(frame, model, class_names, upload_folder, output_folder, static_dir, conf=0.5, iou=0.5):
    """Run YOLO detection on a single frame, save input/output images.

    Returns: (result_dict, cmd_str)
    """
    try:
        # ensure folders exist
        os.makedirs(upload_folder, exist_ok=True)
        os.makedirs(output_folder, exist_ok=True)

        # save original image
        timestamp = str(uuid.uuid4())[:8]
        filename = f"camera_{timestamp}.jpg"
        save_path = os.path.join(upload_folder, filename)
        cv2.imwrite(save_path, frame)

        # run model
        results = model(frame, conf=conf, iou=iou)

        # draw / create output image
        try:
            img_out = results[0].plot()
        except Exception:
            img_out = frame

        name_only = os.path.splitext(filename)[0]
        ext = os.path.splitext(filename)[1]
        output_filename = f"{name_only}_detect{ext}"
        output_path = os.path.join(output_folder, output_filename)
        cv2.imwrite(output_path, img_out)

        # count classes
        num_classes = len(class_names) if class_names else 6
        counts = [0] * num_classes
        try:
            boxes = results[0].boxes
            if hasattr(boxes, 'cls'):
                cls_vals = boxes.cls
                # Convert class values to plain Python ints to avoid numpy __array__ deprecation
                try:
                    cls_arr = [int(x) for x in cls_vals]
                except Exception:
                    try:
                        cls_arr = [int(float(x)) for x in cls_vals]
                    except Exception:
                        cls_arr = []
                for c in cls_arr:
                    if 0 <= int(c) < num_classes:
                        counts[int(c)] += 1
        except Exception:
            counts = [0] * num_classes

        total_vehicles = sum(counts)

        # mapping total vehicles -> seconds and cmd
        if 0 < total_vehicles < 5:
            total_seconds = 20
            cmd = "m1"
        elif 5 <= total_vehicles <= 10:
            total_seconds = 45
            cmd = "m2"
        elif 10 < total_vehicles <= 20:
            total_seconds = 60
            cmd = "m3"
        elif total_vehicles > 20:
            total_seconds = 90
            cmd = "m4"
        else:
            total_seconds = 30
            cmd = "m0"

        yellow_seconds = 3
        red_seconds = int(total_seconds)
        green_seconds = max(0, red_seconds - yellow_seconds)

        processed_url = f"/static/outputs/{output_filename}"
        input_url = f"/static/uploads/{filename}"

        result = {
            "processed_image_url": processed_url,
            "input_image_url": input_url,
            "counts": counts,
            "total_vehicles": total_vehicles,
            "total_seconds": total_seconds,
            "green_seconds": green_seconds,
            "status": "ready",
            "timestamp": int(time.time())
        }
        # write last_detection.json so frontend polling can pick up UART-triggered detects
        try:
            last_path = os.path.join(static_dir, 'last_detection.json')
            with open(last_path, 'w', encoding='utf-8') as jf:
                json.dump(result, jf, ensure_ascii=False)
        except Exception:
            pass

        return result, cmd

    except Exception as e:
        # on error return minimal info; do not write last_detection.json
        return {"error": str(e)}, "m0"
#==============================    
#==== Giao diện chính =========
#==============================
@app.route("/")
def index():
    # Trả về giao diện chính + gửi danh sách tên lớp về frontend
    return render_template("index.html", class_names=CLASS_NAMES)

#======================================
# CAMERA HANDLER - Quản lý camera trong thread riêng
#======================================
class CameraHandler:
    # ===== __init__ =====
    # Khởi tạo camera handler: thiết lập source, khoảng time reconnect, ngưỡng frame lỗi
    def __init__(self, src=0, reconnect_interval=2.0, max_missed=20):
        self.src = src
        self.reconnect_interval = reconnect_interval  # khoảng time reconnect (giây)
        self.max_missed = max_missed  # số frame lỗi tối đa trước khi reset camera
        self.cap = None          # đối tượng VideoCapture
        self.frame = None        # frame mới nhất
        self.lock = threading.Lock()   # tránh xung đột khi đọc / ghi frame
        self.thread = None
        self.running = False
        self._missed = 0         # đếm số frame lỗi liên tiếp
    # ===== _open =====
    # Mở kết nối camera: nếu đang mở thì release rồi mở lại
    def _open(self):
        """ Mở kết nối camera. Nếu đang mở thì release rồi mở lại. """
        try:
            if self.cap is not None:
                try:
                    self.cap.release()
                except Exception:
                    pass
            # Windows dùng CAP_DSHOW tránh delay lúc mở camera
            if os.name == 'nt':
                self.cap = cv2.VideoCapture(self.src, cv2.CAP_DSHOW)
            else:
                self.cap = cv2.VideoCapture(self.src)
            # giảm buffer để hạn chế độ trễ
            try:
                self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            except Exception:
                pass
        except Exception:
            self.cap = None
    # ===== start =====
    # Bắt đầu đọc camera trong thread nền riêng
    def start(self):
        """ Bắt đầu đọc camera trong thread nền riêng """
        if self.running:
            return
        self.running = True
        self._open()  # mở camera lần đầu
        self.thread = threading.Thread(target=self._reader, daemon=True)
        self.thread.start()
    # ===== _reader =====
    # Luồng nền: đọc camera theo vòng lặp liên tục, lưu frame mới nhất, xử lý reconnect
    def _reader(self):
        """ Luồng nền: đọc camera theo vòng lặp liên tục """
        while self.running:
            if self.cap is None or not self.cap.isOpened():
                self._open()                        # thử mở lại camera
                time.sleep(self.reconnect_interval)
                continue
            try:
                ret, frame = self.cap.read()       # đọc một frame
            except Exception:
                ret, frame = False, None
            if not ret or frame is None:
                self._missed += 1
                if self._missed >= self.max_missed:
                    # Nếu lỗi quá nhiều → reset camera
                    try:
                        self._open()
                    except Exception:
                        pass
                    self._missed = 0
                time.sleep(0.05)
                continue
            # Lưu frame vào biến chung
            with self.lock:
                self.frame = frame.copy()

            self._missed = 0
            time.sleep(0.01)

    # ===== read =====
    # Lấy frame mới nhất từ camera handler
    def read(self):
        """ Lấy frame mới nhất """
        with self.lock:
            if self.frame is None:
                return False, None
            return True, self.frame.copy()

    # ===== is_opened =====
    # Kiểm tra camera có mở được hay không
    def is_opened(self):
        """ Kiểm tra camera có mở được hay không """
        return self.cap is not None and self.cap.isOpened()

    # ===== stop =====
    # Tắt thread đọc camera khi app dừng
    def stop(self):
        """ Tắt thread đọc camera khi app dừng """
        self.running = False
        if self.thread is not None:
            self.thread.join(timeout=1.0)
        try:
            if self.cap is not None:
                self.cap.release()
        except Exception:
            pass

# Khởi tạo handler và bắt đầu đọc camera
camera_handler = CameraHandler(0)
camera_handler.start()

# Khi app đóng → đảm bảo tắt camera
atexit.register(lambda: camera_handler.stop())

# -------------------------------------------------------------------------
# UART HANDLER - Giao tiếp với ESP32
# -------------------------------------------------------------------------
class UARTHandler:
    # ===== __init__ =====
    # Khởi tạo UART handler: thiết lập port, baudrate, timeout, kết nối
    def __init__(self, port="/dev/ttyAMA0", baudrate=115200, timeout=1):
        self.port = port
        self.baudrate = baudrate
        self.timeout = timeout
        self.uart = None
        self.lock = threading.Lock()
        self.running = False
        self.thread = None
        self._connect()
    
    # ===== _connect =====
    # Kết nối UART với serial port (nếu pyserial có sẵn)
    def _connect(self):
        try:
            if serial is None:
                print("serial module not available")
                return
            self.uart = serial.Serial(self.port, self.baudrate, timeout=self.timeout)
            print(f"UART connected to {self.port}")
        except Exception as e:
            print(f"UART connection failed: {e}")
            self.uart = None
    
    # ===== send =====
    # Gửi cmd/message đến ESP32 qua UART
    def send(self, msg):
        if self.uart is None:
            return False
        try:
            with self.lock:
                self.uart.write((msg + "\n").encode())
                print(f"UART sent: {msg}")
            return True
        except Exception as e:
            print(f"UART send error: {e}")
            return False
    
    # ===== start_listening =====
    # Bắt đầu thread lắng nghe UART từ ESP32
    def start_listening(self):
        if self.running:
            return
        self.running = True
        self.thread = threading.Thread(target=self._listen, daemon=True)
        self.thread.start()
        print("UART listener started")
    
    # ===== _listen =====
    # Thread nền: lắng nghe UART từ ESP32, trigger xử lý khi nhận 'yell'
    def _listen(self):
        while self.running:
            if self.uart is None or not self.uart.is_open:
                time.sleep(0.5)
                continue
            try:
                data = self.uart.readline().decode().strip()
                if data:
                    print(f"UART received: {data}")
                    if data.lower() == "yell":
                        # Trigger auto capture & detect
                        self._handle_yell()
            except Exception as e:
                print(f"UART read error: {e}")
                time.sleep(0.1)

    # ===== _handle_yell =====
    # Xử lý khi nhận 'yell' từ ESP32: chụp ảnh, detect, lưu, gửi lại m1..m4
    def _handle_yell(self):
        try:
            # Use the shared capture flow so behavior matches /camera_capture
            res, cmd = capture_and_detect(conf=0.5, iou=0.5)
            if isinstance(res, dict) and res.get('error'):
                print(f"Yell capture error: {res.get('error')}")
                self.send("m0")
            else:
                self.send(cmd)
                print(f"Detected {res.get('total_vehicles', 0)} vehicles, sent {cmd}")
        except Exception as e:
            print(f"Error handling yell: {e}")
    
    # ===== stop =====
    # Tắt UART: dừng thread lắng nghe, đóng serial port
    def stop(self):
        """Tắt UART"""
        self.running = False
        if self.thread:
            self.thread.join(timeout=1)
        try:
            if self.uart:
                self.uart.close()
        except:
            pass

uart_handler = UARTHandler()
uart_handler.start_listening()
atexit.register(lambda: uart_handler.stop())

# -------------------------------------------------------------------------
# STREAM CAMERA RA TRÌNH DUYỆT DẠNG MJPEG
# -------------------------------------------------------------------------
def gen_camera_frames():
    """
    Gửi camera live stream dạng MJPEG (ảnh JPEG nối liên tục).
    Trình duyệt <img> tự cập nhật để tạo hiệu ứng video.
    """
    if not camera_handler.is_opened():
        yield b''
        return

    while True:
        ret, frame = camera_handler.read()

        if not ret or frame is None:
            time.sleep(0.05)
            continue

        # encode khung ảnh thành JPG
        ret2, jpeg = cv2.imencode('.jpg', frame)
        if not ret2:
            continue

        # MJPEG streaming trả về block JPEG
        yield (b'--frame\r\n'
               b'Content-Type: image/jpeg\r\n\r\n' + jpeg.tobytes() + b'\r\n')

@app.route('/camera_stream')
def camera_stream():
    """
    API hiển thị camera live stream.
    """
    return Response(gen_camera_frames(),
                    mimetype='multipart/x-mixed-replace; boundary=frame')

# -------------------------------------------------------------------------
# API CHỤP ẢNH + CHẠY YOLO + TRẢ KẾT QUẢ
# -------------------------------------------------------------------------
def capture_and_detect(conf=0.5, iou=0.5):
    """Helper: read camera, run detect_frame, return (result_dict, cmd)

    Returns tuple (result, cmd). On error, result contains 'error' key.
    """
    if not camera_handler.is_opened():
        return {"error": "Camera not available"}, "m0"

    ret, frame = camera_handler.read()
    if not ret or frame is None:
        return {"error": "Không chụp được khung từ camera"}, "m0"

    if model is None:
        return {"error": "Model not loaded"}, "m0"

    try:
        res, cmd = detect_frame(frame, model, CLASS_NAMES, UPLOAD_FOLDER, OUTPUT_FOLDER, STATIC_DIR, conf=conf, iou=iou)
        return res, cmd
    except Exception as e:
        return {"error": str(e)}, "m0"

@app.route('/camera_capture', methods=['POST'])
def camera_capture():
    try:
        conf = float(request.args.get('conf', 0.5))
    except Exception:
        conf = 0.5
    try:
        iou = float(request.args.get('iou', 0.5))
    except Exception:
        iou = 0.5

    res, cmd = capture_and_detect(conf, iou)

    if isinstance(res, dict) and res.get('error'):
        return jsonify(res), 500

    return jsonify(res)

# -------------------------------------------------------------------------
# CHAY SERVER FLASK
# -------------------------------------------------------------------------
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
