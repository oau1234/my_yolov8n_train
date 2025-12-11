// =======================
//   FRONTEND MAIN SCRIPT 
//   (ĐÃ THÊM CHÚ THÍCH TIẾNG VIỆT)
//   KHÔNG CÒN AUTO-CYCLE
//   CHỈ CHỤP KHI NGƯỜI DÙNG BẤM NÚT
// =======================

// ====== LẤY CÁC PHẦN TỬ HTML ======
const form = document.getElementById("yoloForm");
const imageInput = document.getElementById("imageInput");
const fileNameDisplay = document.getElementById("fileName");

const confSlider = document.getElementById("confSlider");
const iouSlider = document.getElementById("iouSlider");
const confVal = document.getElementById("confVal");
const iouVal = document.getElementById("iouVal");

const originalImg = document.getElementById("originalImg");
const processedImg = document.getElementById("processedImg");
const cameraPreview = document.getElementById("cameraPreview");
const cameraCaptureBtn = document.getElementById("cameraCaptureBtn");

const downloadBtn = document.getElementById("downloadBtn");
const loading = document.getElementById("loading");
const errorMessage = document.getElementById("errorMessage");

const timeDisplay = document.getElementById("timeDisplay");

// ==============================================
//   BỘ ĐẾM THỜI GIAN XỬ LÝ (HIỆN 00:00:00)
// ==============================================
let timerInterval = null;
let startTime = null;

function startTimer() {
    startTime = Date.now();
    if (timerInterval) clearInterval(timerInterval);

    timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const h = String(Math.floor(elapsed / 3600)).padStart(2, "0");
        const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, "0");
        const s = String(elapsed % 60).padStart(2, "0");
        timeDisplay.textContent = `${h}:${m}:${s}`;
    }, 200);
}

function stopTimer() {
    if (timerInterval) clearInterval(timerInterval);
    timeDisplay.textContent = "00:00:00";
}

// ==============================================
//      HIỆN LOADING + KHÓA NÚT BẤM
// ==============================================
function uiStart() {
    loading.style.display = "block";
    form.querySelector(".btn-primary").disabled = true;
    startTimer();
}

function uiEnd() {
    loading.style.display = "none";
    form.querySelector(".btn-primary").disabled = false;
    stopTimer();
}

function showError(msg) {
    errorMessage.textContent = msg;
    errorMessage.style.display = msg ? "block" : "none";
}

// Tạo URL không cache
function noCache(url) {
    return url + "?t=" + Date.now();
}

// ==============================================
//   CẬP NHẬT MẬT ĐỘ XE TRÊN GIAO DIỆN
// ==============================================
function updateDensity(count) {
    const total = document.getElementById("totalVehicles");
    const level = document.getElementById("densityLevel");

    total.textContent = count;

    if (count < 5) level.textContent = "🟢 Ít";
    else if (count <= 10) level.textContent = "🟡 Trung bình";
    else if (count <= 15) level.textContent = "🟠 Khá";
    else level.textContent = "🔴 Đông";
}

// ==============================================
//   CẬP NHẬT THỜI GIAN ĐÈN TÍN HIỆU
// ==============================================
function updateLightTimes(g, y, r) {
    document.getElementById("greenTime").textContent = `${g}s`;
    document.getElementById("yellowTime").textContent = `${y}s`;
    document.getElementById("redTime").textContent = `${r}s`;
}

// ==============================================
//     HIỆN ẢNH ĐÃ XỬ LÝ
// ==============================================
function showProcessedImage(url) {
    processedImg.onload = () => processedImg.classList.add("active");
    processedImg.src = url;
}

// ==============================================
//   XỬ LÝ JSON TRẢ VỀ SAU KHI DETECT
// ==============================================
function handleCaptureResponse(data) {
    // ----------- Đếm xe -----------  
    let totalCount = 0;
    if (Array.isArray(data.counts)) {
        data.counts.forEach((c, i) => {
            const el = document.getElementById(`count-${i}`);
            if (el) el.textContent = c;
            totalCount += c;
        });
    }
    updateDensity(totalCount);

    // ----------- Ảnh gốc -----------  
    if (data.input_image_url) {
        originalImg.src = noCache(data.input_image_url);
        originalImg.classList.add("active");
    }

    // ----------- Ảnh detect -----------  
    if (data.processed_image_url) {
        showProcessedImage(noCache(data.processed_image_url));
        downloadBtn.href = data.processed_image_url;
    }

    // ----------- Thời gian đèn -----------
    // Server returns `total_seconds` (red+yellow) and `green_seconds`.
    // Keep compatibility: prefer explicit red/yellow if provided,
    // otherwise derive red from total_seconds and use default yellow=3.
    const yellow = data.yellow_seconds ?? 3;
    const total = data.total_seconds ?? data.red_seconds ?? 0;
    const red = total; // server's total_seconds corresponds to red time in app logic
    const green = data.green_seconds ?? Math.max(0, red - yellow);

    updateLightTimes(green, yellow, red);

    showError("");
}

// ==============================================
//   GỌI API /camera_capture (KHI BẤM NÚT)
// ==============================================
async function captureFrameAndSend() {
    uiStart();
    showError("");

    try {
        const conf = confSlider.value;
        const iou = iouSlider.value;

        const res = await fetch(`/camera_capture?conf=${conf}&iou=${iou}`, {
            method: "POST"
        });

        if (!res.ok) throw new Error("Lỗi server: " + res.status);

        const data = await res.json();
        if (data.error) throw new Error(data.error);

        handleCaptureResponse(data);
    }
    catch (err) {
        showError("Lỗi: " + err.message);
    }
    finally {
        uiEnd();
    }
}

// ==============================================
//     HIỂN THỊ CAMERA STREAM LÊN TRANG
// ==============================================
function startCamera() {
    cameraPreview.src = "/camera_stream";
}

// ==============================================
//     SỰ KIỆN KHỞI TẠO TRANG
// ==============================================
window.addEventListener("DOMContentLoaded", () => {
    // Chỉ hiển thị camera – KHÔNG tự detect
    startCamera();
    // Bắt đầu polling file last_detection.json để cập nhật ảnh khi có detect từ UART
    startLastDetectionPolling();
});

// ==============================================
//     NÚT "📸 Chụp & Detect"
// ==============================================
cameraCaptureBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    await captureFrameAndSend();
});

// ==============================================
//     HIỂN THỊ TÊN FILE ẢNH (KHI UPLOAD)
// ==============================================
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

// ==============================================
//     CẬP NHẬT TEXT CHO SLIDER CONF & IOU
// ==============================================
confSlider.addEventListener("input", e => {
    confVal.textContent = e.target.value;
});
iouSlider.addEventListener("input", e => {
    iouVal.textContent = e.target.value;
});

// ==============================================
//     NÚT PHÂN TÍCH TRONG FORM (NẾU CÓ)
// ==============================================
form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await captureFrameAndSend();
});

// ==========================
// Polling last_detection.json
// ==========================
let lastDetectionTimestamp = 0;
let lastPollInterval = null;

async function pollLastDetection() {
    try {
        const res = await fetch(noCache('/static/last_detection.json'));
        if (!res.ok) return;
        const data = await res.json();
        if (!data || !data.timestamp) return;
        if (data.timestamp > lastDetectionTimestamp) {
            lastDetectionTimestamp = data.timestamp;
            // Update UI using existing handler
            handleCaptureResponse(data);
        }
    } catch (e) {
        // ignore fetch errors (file may not exist yet)
    }
}

function startLastDetectionPolling(intervalMs = 2000) {
    if (lastPollInterval) return;
    // poll immediately, then set interval
    pollLastDetection();
    lastPollInterval = setInterval(pollLastDetection, intervalMs);
}

function stopLastDetectionPolling() {
    if (!lastPollInterval) return;
    clearInterval(lastPollInterval);
    lastPollInterval = null;
}
