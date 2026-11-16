/* Small Emscripten bridge to the LGPL libde265 decoder. */
#include <stdint.h>
#include <stdlib.h>
#include "de265.h"

typedef struct {
  de265_decoder_context *decoder;
  int width;
  int height;
} h265_context;

__attribute__((visibility("default")))
void *h265_create(void) {
  h265_context *ctx = (h265_context *)calloc(1, sizeof(h265_context));
  if (!ctx) return NULL;
  ctx->decoder = de265_new_decoder();
  if (!ctx->decoder) { free(ctx); return NULL; }
  return ctx;
}

__attribute__((visibility("default")))
void h265_destroy(void *opaque) {
  h265_context *ctx = (h265_context *)opaque;
  if (!ctx) return;
  de265_free_decoder(ctx->decoder);
  free(ctx);
}

__attribute__((visibility("default")))
void h265_reset(void *opaque) {
  h265_context *ctx = (h265_context *)opaque;
  if (ctx) de265_reset(ctx->decoder);
}

/* data must be one complete Annex B access unit (including start codes). */
__attribute__((visibility("default")))
int h265_decode(void *opaque, const uint8_t *data, int length, de265_PTS pts) {
  h265_context *ctx = (h265_context *)opaque;
  de265_error err = de265_push_data(ctx->decoder, data, length, pts, NULL);
  if (err != DE265_OK) return (int)err;
  de265_push_end_of_frame(ctx->decoder);

  /* A full output queue needs to be drained before the next pump. */
  for (int i = 0; i < 10000; ++i) {
    int more = 0;
    err = de265_decode(ctx->decoder, &more);
    if (!more || err != DE265_OK) break;
  }
  return 0;
}

static uint8_t clamp8(int value) {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return (uint8_t)value;
}

static void pump(h265_context *ctx) {
  for (int i = 0; i < 10000; ++i) {
    int more = 0;
    de265_error err = de265_decode(ctx->decoder, &more);
    if (!more || err != DE265_OK) break;
  }
}

/* Returns malloc'd RGBA8 pixels, or NULL when no output picture is ready.
   Free the returned pointer with h265_release_frame. */
__attribute__((visibility("default")))
uint8_t *h265_next_frame(void *opaque, int *width_out, int *height_out, de265_PTS *pts_out) {
  h265_context *ctx = (h265_context *)opaque;
  const de265_image *image = de265_get_next_picture(ctx->decoder);
  if (!image) {
    pump(ctx);
    image = de265_get_next_picture(ctx->decoder);
  }
  if (!image) return NULL;

  int width = de265_get_image_width(image, 0);
  int height = de265_get_image_height(image, 0);
  int y_stride = 0, u_stride = 0, v_stride = 0;
  const uint8_t *y_plane = de265_get_image_plane(image, 0, &y_stride);
  const uint8_t *u_plane = de265_get_image_plane(image, 1, &u_stride);
  const uint8_t *v_plane = de265_get_image_plane(image, 2, &v_stride);
  if (width <= 0 || height <= 0 || width > 8192 || height > 8192 ||
      !y_plane || !u_plane || !v_plane ||
      de265_get_chroma_format(image) != de265_chroma_420 ||
      de265_get_bits_per_pixel(image, 0) != 8) {
    de265_release_next_picture(ctx->decoder);
    return (uint8_t *)1; /* distinguish unsupported/capped output from no frame */
  }

  uint8_t *rgba = (uint8_t *)malloc((size_t)width * height * 4);
  if (!rgba) {
    de265_release_next_picture(ctx->decoder);
    return (uint8_t *)1;
  }

  const int full_range = de265_get_image_full_range_flag(image);
  for (int y = 0; y < height; ++y) {
    const uint8_t *yp = y_plane + y * y_stride;
    const uint8_t *up = u_plane + (y / 2) * u_stride;
    const uint8_t *vp = v_plane + (y / 2) * v_stride;
    uint8_t *dst = rgba + (size_t)y * width * 4;
    for (int x = 0; x < width; ++x) {
      int yy = yp[x], uu = (int)up[x / 2] - 128, vv = (int)vp[x / 2] - 128;
      int r, g, b;
      if (full_range) {
        r = yy + (403 * vv + 128) / 256;
        g = yy - (48 * uu + 120 * vv + 128) / 256;
        b = yy + (475 * uu + 128) / 256;
      } else {
        int c = yy - 16;
        r = (298 * c + 459 * vv + 128) / 256;
        g = (298 * c - 55 * uu - 136 * vv + 128) / 256;
        b = (298 * c + 541 * uu + 128) / 256;
      }
      dst[4 * x + 0] = clamp8(r);
      dst[4 * x + 1] = clamp8(g);
      dst[4 * x + 2] = clamp8(b);
      dst[4 * x + 3] = 255;
    }
  }

  ctx->width = width;
  ctx->height = height;
  *width_out = width;
  *height_out = height;
  *pts_out = de265_get_image_PTS(image);
  de265_release_next_picture(ctx->decoder);
  return rgba;
}

__attribute__((visibility("default")))
void h265_release_frame(uint8_t *frame) { free(frame); }

__attribute__((visibility("default")))
const char *h265_error_text(int error_code) {
  return de265_get_error_text((de265_error)error_code);
}
