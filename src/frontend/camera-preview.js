/* Camera-neutral low-latency preview. The adapter owns the device connection;
 * this client accepts only loopback sessions carrying Annex B HEVC and boxes. */
(function (root) {
  "use strict";
  class CameraPreview {
    constructor({ canvas, onFrame = () => {}, onError = () => {}, onDimensions = () => {} }) {
      this.canvas = canvas;
      this.context = canvas.getContext("2d", { alpha: false });
      this.onFrame = onFrame;
      this.onError = onError;
      this.onDimensions = onDimensions;
      this.closed = false;
      this.metadata = new Map();
      this.pending = null;
      this.waitingForKey = true;
      this.workerInFlight = 0;
      this.lastFrameAt = Date.now();
    }
    static sessionUrl(value) {
      const url = new URL(value);
      if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
          url.username || url.password || url.hash || !url.port || url.pathname.length < 16) {
        throw new Error("The adapter returned an invalid local preview session.");
      }
      return url.href;
    }
    async start(session) {
      if (session.format !== "hevc-annexb-v1" || !this.context) throw new Error("Unsupported camera preview format.");
      const url = CameraPreview.sessionUrl(session.url);
      this.session = session;
      await this.createDecoder(false);
      if (this.closed) return;
      const socket = this.socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      socket.onmessage = (event) => this.receive(event.data);
      socket.onerror = () => this.fail("Could not connect to the camera preview.");
      socket.onclose = () => { if (!this.closed) this.fail("The camera preview connection closed."); };
      this.lastFrameAt = Date.now();
      this.watchdog = setInterval(() => {
        if (Date.now() - this.lastFrameAt > (this.hasFrame ? 4000 : 12000)) this.fail("The camera preview stopped delivering pictures.");
      }, 1000);
    }
    async createDecoder(forceWasm) {
      if (!forceWasm && typeof VideoDecoder !== "undefined" && typeof EncodedVideoChunk !== "undefined") {
        try {
          const config = { codec: this.session.codec || "hev1.1.6.L93.B0", optimizeForLatency: true };
          const support = await VideoDecoder.isConfigSupported(config);
          if (support.supported && !this.closed) {
            const decoder = new VideoDecoder({
              output: (frame) => {
                try { this.draw(frame, frame.displayWidth, frame.displayHeight, frame.timestamp); }
                finally { frame.close(); }
              },
              error: () => this.useWasm()
            });
            try { decoder.configure(config); }
            catch (error) { decoder.close(); throw error; }
            this.decoder = decoder;
            return;
          }
        } catch (_) { /* A supported configuration must also decode real frames. */ }
      }
      if (this.closed) return;
      await new Promise((resolve, reject) => {
        const worker = this.worker = new Worker("/preview-decoder/worker.js");
        let settled = false;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(this.decoderTimer);
          this.decoderTimer = null;
          this.decoderReady = null;
          callback(value);
        };
        this.decoderReady = {
          reject: (error) => finish(reject, error)
        };
        this.decoderTimer = setTimeout(() => finish(reject, new Error("The preview decoder did not start.")), 10000);
        worker.onerror = () => { finish(reject, new Error("Could not load the browser video decoder.")); this.fail("Could not load the browser video decoder."); };
        worker.onmessage = ({ data }) => {
          if (this.closed) return;
          if (data.type === "ready") finish(resolve);
          else if (data.type === "decoded") this.workerInFlight = Math.max(0, this.workerInFlight - 1);
          else if (data.type === "error") { const error = new Error(data.message || "The preview decoder failed."); finish(reject, error); this.fail(error.message); }
          else if (data.type === "frame") {
            const { width, height, timestamp } = data;
            if (!(width > 0 && height > 0 && width <= 8192 && height <= 8192) || data.data.byteLength !== width * height * 4) {
              this.fail("The decoder returned an invalid picture."); return;
            }
            this.draw(new ImageData(new Uint8ClampedArray(data.data), width, height), width, height, timestamp);
          }
        };
        worker.postMessage({ type: "init" });
      });
    }
    useWasm() {
      if (this.closed || this.switchingDecoder || this.worker) return;
      this.switchingDecoder = true;
      try { this.decoder?.close(); } catch (_) {}
      this.decoder = null;
      this.waitingForKey = true;
      this.metadata.clear();
      this.createDecoder(true).then(() => { this.switchingDecoder = false; }).catch((error) => this.fail(error.message));
    }
    receive(data) {
      if (this.closed) return;
      try {
        if (typeof data === "string") {
          const meta = JSON.parse(data);
          if (meta.type === "error") return this.fail(meta.message);
          if (meta.type !== "frame" || !Number.isSafeInteger(meta.timestamp) || meta.timestamp < 0 || typeof meta.key !== "boolean") {
            throw new Error("Invalid camera preview metadata.");
          }
          this.pending = meta;
          return;
        }
        const meta = this.pending;
        this.pending = null;
        if (!meta || !(data instanceof ArrayBuffer) || !data.byteLength || data.byteLength > 8 * 1024 * 1024) {
          throw new Error("Invalid camera preview picture.");
        }
        if (this.switchingDecoder || (this.waitingForKey && !meta.key)) return;
        if (this.worker && this.workerInFlight >= 4) {
          this.waitingForKey = true;
          this.workerNeedsReset = true;
          this.metadata.clear();
          return;
        }
        if (!this.worker && this.decoder?.decodeQueueSize > 6) {
          // Delta frames depend on earlier pictures: after dropping, resume at a keyframe.
          this.decoder.reset();
          this.decoder.configure({ codec: this.session.codec || "hev1.1.6.L93.B0", optimizeForLatency: true });
          this.waitingForKey = true;
          this.metadata.clear();
          if (!meta.key) return;
        }
        if (this.worker && this.workerNeedsReset) {
          this.worker.postMessage({ type: "reset" });
          this.workerNeedsReset = false;
        }
        this.waitingForKey = false;
        this.firstTimestamp ??= meta.timestamp;
        const timestamp = Math.max(0, meta.timestamp - this.firstTimestamp);
        this.metadata.set(timestamp, meta);
        while (this.metadata.size > 120) this.metadata.delete(this.metadata.keys().next().value);
        if (this.worker) {
          this.workerInFlight += 1;
          this.worker.postMessage({ type: "decode", data, timestamp }, [data]);
        }
        else this.decoder.decode(new EncodedVideoChunk({ type: meta.key ? "key" : "delta", timestamp, data }));
      } catch (error) {
        if (this.decoder && !this.worker) this.useWasm();
        else this.fail(error.message);
      }
    }
    draw(image, width, height, timestamp) {
      if (this.closed) return;
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width; this.canvas.height = height;
        this.onDimensions({ width, height });
      }
      if (typeof ImageData !== "undefined" && image instanceof ImageData) this.context.putImageData(image, 0, 0);
      else this.context.drawImage(image, 0, 0, width, height);
      const meta = this.metadata.get(timestamp);
      // A target belongs to this picture; never reuse a previous picture's box.
      this.metadata.delete(timestamp);
      const box = meta?.tracking;
      if (box && [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
          box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0 &&
          box.x + box.width <= 1.00001 && box.y + box.height <= 1.00001) {
        const x = box.x * width, y = box.y * height, w = box.width * width, h = box.height * height;
        this.context.strokeStyle = "rgba(255,255,255,0.5)"; this.context.lineWidth = 1;
        this.context.strokeRect(x, y, w, h);
        const length = Math.min(18, w / 3, h / 3);
        this.context.strokeStyle = "#39ffa8"; this.context.lineWidth = 3;
        this.context.beginPath();
        for (const [px, py, dx, dy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
          this.context.moveTo(px, py + dy * length); this.context.lineTo(px, py); this.context.lineTo(px + dx * length, py);
        }
        this.context.stroke();
      }
      this.hasFrame = true;
      this.lastFrameAt = Date.now();
      this.onFrame();
    }
    fail(message) {
      if (this.closed) return;
      this.close();
      this.onError(String(message || "Camera preview failed."));
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      clearInterval(this.watchdog);
      clearTimeout(this.decoderTimer);
      this.decoderReady?.reject(new Error("The camera preview was closed."));
      this.socket?.close();
      try { this.decoder?.close(); } catch (_) {}
      this.worker?.terminate();
      this.metadata.clear();
    }
  }
  root.CameraPreview = CameraPreview;
})(globalThis);
