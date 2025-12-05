// ==========================================
// DOM Elements – Lấy các phần tử giao diện
// ==========================================
const form = document.getElementById("yoloForm");
const imageInput = document.getElementById("imageInput");
const fileNameDisplay = document.getElementById("fileName");

const confSlider = document.getElementById("confSlider"); // Thanh trượt CONFIDENCE
const iouSlider = document.getElementById("iouSlider");   // Thanh trượt IOU
const confVal = document.getElementById("confVal");
const iouVal = document.getElementById("iouVal");

const originalImg = document.getElementById("originalImg");   // Ảnh gốc
const processedImg = document.getElementById("processedImg"); // Ảnh sau khi detect
const cameraPreview = document.getElementById("cameraPreview"); // Luồng STREAM camera
const cameraCaptureBtn = document.getElementById("cameraCaptureBtn"); // Nút chụp ảnh

const downloadBtn = document.getElementById("downloadBtn"); // Nút tải ảnh detect
const loading = document.getElementById("loading");         // Loading icon
const errorMessage = document.getElementById("errorMessage"); // Hiện lỗi

const timeDisplay = document.getElementById("timeDisplay"); // Đồng hồ thời gian xử lý

// ==========================================
// Bộ công cụ UI (quản lý timer & trạng thái)
// ==========================================
let timerInterval = null;
let startTime = null;

// Auto-cycle: chế độ tự động (chụp → detect → đếm ngược → chụp tiếp)
let autoCycle = true;
let greenIntervalId = null;
let isCapturing = false;
let greenRemaining = 0;

// --- Đồng hồ hiển thị thời gian xử lý
function startTimer() {
    startTime = Date.now();
    if (timerInterval) clearInterval(timerInterval);

    timerInterval = setInterval(() => {
        if (!timeDisplay) return;
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const h = String(Math.floor(elapsed / 3600)).padStart(2, "0");
        const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, "0");
        const s = String(elapsed % 60).padStart(2, "0");
        timeDisplay.textContent = `${h}:${m}:${s}`;
    }, 100);
}

// Dừng và reset đồng hồ
function stopTimer() {
    if (timerInterval) clearInterval(timerInterval);
    if (timeDisplay) timeDisplay.textContent = "00:00:00";
}

// UI bắt đầu xử lý
function uiStart() {
    loading.style.display = "block";
    if (form.querySelector(".btn-primary")) form.querySelector(".btn-primary").disabled = true;
    startTimer();
}

// UI hoàn tất xử lý
function uiEnd() {
    loading.style.display = "none";
    if (form.querySelector(".btn-primary")) form.querySelector(".btn-primary").disabled = false;
    stopTimer();
}

// Hiển thị lỗi
function showError(msg) {
    errorMessage.textContent = msg;
    errorMessage.style.display = msg ? "block" : "none";
}

// Hàm chống cache để load ảnh mới liên tục
function noCache(url) {
    return url + "?t=" + Date.now();
}

// ==========================================
// TẠO FormData upload ảnh (kèm conf & iou)
// ==========================================
function createUploadForm(key, value, filename = null) {
    const fd = new FormData();
    if (filename) fd.append(key, value, filename);
    else fd.append(key, value);

    fd.append("conf", confSlider.value);
    fd.append("iou", iouSlider.value);
    return fd;
}

// ==========================================
// Cập nhật mật độ xe + thời gian đèn
// ==========================================
function updateDensity(count) {
    const total = document.getElementById("totalVehicles");
    const level = document.getElementById("densityLevel");

    if (total) total.textContent = count;

    if (level) {
        if (count < 5) level.textContent = "🟢 Ít";
        else if (count <= 10) level.textContent = "🟡 Trung bình";
        else if (count <= 15) level.textContent = "🟠 Khá";
        else level.textContent = "🔴 Đông";
    }
}

// Cập nhật lên UI thời gian đèn tín hiệu
function updateLightTimes(g, y, r) {
    if (document.getElementById("greenTime")) document.getElementById("greenTime").textContent = `${g}s`;
    if (document.getElementById("yellowTime")) document.getElementById("yellowTime").textContent = `${y}s`;
    if (document.getElementById("redTime")) document.getElementById("redTime").textContent = `${r}s`;
}

// Hiển thị ảnh detect
function showProcessedImage(url) {
    if (processedImg) {
        processedImg.onload = () => processedImg.classList.add("active");
        processedImg.src = url;
    }
}

// ==========================================
// Xử lý phản hồi API sau khi detect
// ==========================================
function handleUploadResponse(data) {
    // --- Đếm từng loại xe
    let total = 0;
    if (Array.isArray(data.counts)) {
        data.counts.forEach((c, i) => {
            const el = document.getElementById(`count-${i}`);
            if (el) el.textContent = c;
            total += c;
        });
    }

    updateDensity(total);

    // --- Cho phép tải ảnh detect
    if (data.processed_image_url && downloadBtn) {
        downloadBtn.href = data.processed_image_url;
    }

    // --- Cập nhật thời gian đèn
    if (typeof data.red_seconds === "number") {
        const r = data.red_seconds;
        const y = data.yellow_seconds ?? 3;
        const g = data.green_seconds ?? Math.max(0, r - y);
        updateLightTimes(g, y, r);

        // Nếu auto mode thì bắt đầu đếm ngược đèn xanh
        if (autoCycle && g > 0) startGreenCountdown(g);
    }
}

// ==========================================
// Đếm ngược đèn xanh → hết → tự chụp tiếp
// ==========================================
function startGreenCountdown(seconds) {
    stopGreenCountdown();
    if (!autoCycle) return;

    greenRemaining = Math.floor(seconds);
    const elG = document.getElementById("greenTime");
    if (elG) elG.textContent = `${greenRemaining}s`;

    greenIntervalId = setInterval(async () => {
        greenRemaining -= 1;
        if (elG) elG.textContent = `${Math.max(0, greenRemaining)}s`;

        if (greenRemaining <= 0) {
            stopGreenCountdown();
            if (!isCapturing) await captureFrameAndSend();
        }
    }, 1000);
}

// Dừng đếm ngược
function stopGreenCountdown() {
    if (greenIntervalId) {
        clearInterval(greenIntervalId);
        greenIntervalId = null;
    }
}

// ==========================================
// Gửi ảnh upload thủ công (nếu dùng upload form)
// ==========================================
async function sendToUpload(formData) {
    uiStart();

    try {
        const res = await fetch("/upload", { method: "POST", body: formData });
        if (!res.ok) throw new Error("Server error: " + res.status);

        const data = await res.json();
        if (data.error) throw new Error(data.error);

        showProcessedImage(noCache(data.processed_image_url));
        handleUploadResponse(data);
        showError("");

    } catch (err) {
        showError("Lỗi: " + err.message);
    } finally {
        uiEnd();
    }
}

// ==========================================
// CAMERA – Streaming + Capture + Detect
// ==========================================

// Khởi động camera stream
function startCamera() {
    if (cameraPreview) {
        cameraPreview.src = "/camera_stream";
    }
}

// Gửi yêu cầu chụp từ camera & detect
async function captureFrameAndSend() {
    if (isCapturing) return;
    isCapturing = true;

    try {
        const conf = confSlider.value;
        const iou = iouSlider.value;

        const res = await fetch(`/camera_capture?conf=${conf}&iou=${iou}`, { method: "POST" });
        if (!res.ok) throw new Error("Capture failed: " + res.status);

        const data = await res.json();
        if (data.error) throw new Error(data.error);

        // Ảnh gốc
        if (data.input_image_url && originalImg) {
            originalImg.src = noCache(data.input_image_url);
            originalImg.classList.add("active");
        }

        // Ảnh detect
        if (data.processed_image_url) {
            showProcessedImage(noCache(data.processed_image_url));
        }

        // Cập nhật số liệu đếm xe và timer đèn
        handleUploadResponse(data);

    } catch (err) {
        showError("Camera: " + err.message);
    } finally {
        isCapturing = false;
    }
}

// ==========================================
// SỰ KIỆN – Khởi chạy ban đầu
// ==========================================

window.addEventListener("DOMContentLoaded", () => {
    // Bật camera stream
    startCamera();

    // Auto detect vòng lặp → chụp → detect → đèn → lặp tiếp
    if (autoCycle) {
        setTimeout(() => {
            if (!isCapturing) captureFrameAndSend();
        }, 2000);
    }
});

// Nút chụp thủ công
if (cameraCaptureBtn) {
    cameraCaptureBtn.addEventListener("click", captureFrameAndSend);
}

// ==========================================
// Xử lý hiển thị tên file upload
// ==========================================
if (imageInput) {
    imageInput.addEventListener("change", () => {
        const f = imageInput.files[0];
        if (!f) {
            fileNameDisplay.textContent = "Chưa chọn file";
            fileNameDisplay.style.color = "#999";
            return;
        }
        const ext = f.name.substring(f.name.lastIndexOf("."));
        const base = f.name.replace(ext, "");
        fileNameDisplay.textContent = `✓ ${f.name} → ${base}_detect${ext} (${(f.size / 1024).toFixed(1)} KB)`;
        fileNameDisplay.style.color = "#44dd44";
    });
}

// ==========================================
// Thanh trượt CONF & IOU
// ==========================================
confSlider?.addEventListener("input", e => {
    confVal.textContent = e.target.value;
});

iouSlider?.addEventListener("input", e => {
    iouVal.textContent = e.target.value;
});

// ==========================================
// Form DETECT – bật/tắt auto mode
// ==========================================
if (form) {
    const detectBtn = form.querySelector('.btn-primary');

    function setDetectButtonState(on) {
        detectBtn.textContent = on ? '⏸️ Stop' : '🚀 Detect';
        detectBtn.classList.toggle('running', on);
    }

    form.addEventListener("submit", async (e) => {
        e.preventDefault();

        autoCycle = !autoCycle;
        setDetectButtonState(autoCycle);

        if (autoCycle) {
            if (!isCapturing) await captureFrameAndSend();
        } else {
            stopGreenCountdown();
            showError('Auto mode stopped');
        }
    });
}
