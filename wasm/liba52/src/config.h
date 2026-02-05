/*
 * config.h - Configuration for liba52 WASM build
 */

#ifndef CONFIG_H
#define CONFIG_H

/* Use standard integer types */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* Disable SIMD/ASM optimizations for WASM */
#undef LIBA52_DJBFFT
#undef ARCH_X86
#undef ARCH_X86_64
#undef HAVE_MMX

/* Use single precision float */
#undef LIBA52_DOUBLE

/* Define inline if not available */
#ifndef inline
#define inline __inline__
#endif

#endif /* CONFIG_H */
