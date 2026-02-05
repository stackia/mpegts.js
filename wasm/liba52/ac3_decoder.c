/*
 * AC-3 Audio Decoder - WebAssembly Wrapper
 * 
 * This file provides a simple C interface for decoding AC-3 (Dolby Digital)
 * audio using liba52, exported as WebAssembly functions.
 * 
 * Copyright (C) 2026 mpegts.js contributors
 * Licensed under GPL-2.0 (same as liba52)
 */

#include "src/config.h"
#include "include/a52.h"
#include "src/a52_internal.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT
#endif

#include <stdlib.h>
#include <string.h>

/* AC-3 frame always has 6 blocks of 256 samples = 1536 samples per channel */
#define AC3_SAMPLES_PER_FRAME 1536
#define AC3_MAX_CHANNELS 6

/* Decoder wrapper structure */
typedef struct {
    a52_state_t *state;
    sample_t *samples;
    int initialized;
} AC3Decoder;

/*
 * Create a new AC-3 decoder instance
 * Returns: pointer to decoder state, or NULL on failure
 */
EXPORT
AC3Decoder* ac3_decoder_create(void) {
    AC3Decoder* decoder = (AC3Decoder*)malloc(sizeof(AC3Decoder));
    if (!decoder) {
        return NULL;
    }
    
    /* Initialize liba52 with no SIMD acceleration */
    decoder->state = a52_init(0);
    if (!decoder->state) {
        free(decoder);
        return NULL;
    }
    
    decoder->samples = a52_samples(decoder->state);
    decoder->initialized = 1;
    
    return decoder;
}

/*
 * Destroy decoder instance and free memory
 */
EXPORT
void ac3_decoder_destroy(AC3Decoder* decoder) {
    if (decoder) {
        if (decoder->state) {
            a52_free(decoder->state);
        }
        free(decoder);
    }
}

/*
 * Get sync info from an AC-3 frame header
 * 
 * Parameters:
 *   buf         - input buffer (needs at least 7 bytes for sync info)
 *   out_info    - output array: [flags, sample_rate, bit_rate, frame_size]
 * 
 * Returns: frame size in bytes, or 0 if not a valid sync
 */
EXPORT
int ac3_syncinfo(const unsigned char* buf, int* out_info) {
    int flags, sample_rate, bit_rate;
    int frame_size = a52_syncinfo((uint8_t*)buf, &flags, &sample_rate, &bit_rate);
    
    if (frame_size > 0 && out_info) {
        out_info[0] = flags;
        out_info[1] = sample_rate;
        out_info[2] = bit_rate;
        out_info[3] = frame_size;
    }
    
    return frame_size;
}

/*
 * Decode a complete AC-3 frame
 * 
 * Parameters:
 *   decoder     - decoder instance
 *   input       - input buffer containing complete AC-3 frame
 *   input_size  - size of input buffer (should match frame_size from syncinfo)
 *   output      - output buffer for interleaved float PCM samples
 *                 (must be at least AC3_SAMPLES_PER_FRAME * channels * sizeof(float))
 *   out_info    - output array: [samples_decoded, sample_rate, channels]
 * 
 * Returns: number of samples decoded per channel, or negative on error
 */
EXPORT
int ac3_decode_frame(
    AC3Decoder* decoder,
    const unsigned char* input,
    int input_size,
    float* output,
    int* out_info
) {
    if (!decoder || !decoder->initialized || !input || !output || !out_info) {
        return -1;
    }
    
    int flags, sample_rate, bit_rate;
    int frame_size = a52_syncinfo((uint8_t*)input, &flags, &sample_rate, &bit_rate);
    
    if (frame_size == 0 || frame_size > input_size) {
        return -2; /* Invalid or incomplete frame */
    }
    
    /* Determine output configuration - downmix to stereo for simplicity */
    int output_flags = A52_STEREO;
    sample_t level = 1.0f;
    sample_t bias = 0.0f;
    
    /* Parse the frame */
    if (a52_frame(decoder->state, (uint8_t*)input, &output_flags, &level, bias)) {
        return -3; /* Frame parse error */
    }
    
    /* Get actual channel count from output flags */
    int channels = 2; /* We're downmixing to stereo */
    
    /* Decode all 6 blocks */
    int total_samples = 0;
    for (int i = 0; i < 6; i++) {
        if (a52_block(decoder->state)) {
            return -4; /* Block decode error */
        }
        
        /* Copy interleaved samples to output */
        sample_t* samples = decoder->samples;
        for (int s = 0; s < 256; s++) {
            for (int c = 0; c < channels; c++) {
                output[(total_samples + s) * channels + c] = samples[c * 256 + s];
            }
        }
        total_samples += 256;
    }
    
    /* Fill output info */
    out_info[0] = total_samples;  /* samples per channel */
    out_info[1] = sample_rate;
    out_info[2] = channels;
    
    return total_samples;
}

/*
 * Get the number of samples per AC-3 frame
 */
EXPORT
int ac3_samples_per_frame(void) {
    return AC3_SAMPLES_PER_FRAME;
}

/*
 * Get the maximum number of channels
 */
EXPORT
int ac3_max_channels(void) {
    return AC3_MAX_CHANNELS;
}
