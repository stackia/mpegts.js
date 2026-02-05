# Makefile for minimp3 WASM decoder

EMCC = emcc
OUTPUT = mp2_decoder

# Emscripten flags
EMFLAGS = -O3 \
	-flto \
	-s WASM=1 \
	-s MODULARIZE=1 \
	-s EXPORT_ES6=1 \
	-s EXPORTED_FUNCTIONS='["_mpeg_audio_decoder_create", "_mpeg_audio_decoder_destroy", "_mpeg_audio_decode_frame", "_mpeg_audio_max_samples_per_frame", "_mpeg_audio_decoder_reset", "_malloc", "_free"]' \
	-s EXPORTED_RUNTIME_METHODS='["ccall", "cwrap", "getValue", "setValue", "HEAPU8", "HEAP16", "HEAPF32", "HEAP32"]' \
	-s ALLOW_MEMORY_GROWTH=1 \
	-s INITIAL_MEMORY=1048576 \
	-s STACK_SIZE=65536 \
	-s NO_EXIT_RUNTIME=1 \
	-s FILESYSTEM=0 \
	-s ENVIRONMENT='web,worker' \
	--no-entry

# Source files
SOURCES = mp2_decoder.c

.PHONY: all clean

all: $(OUTPUT).js

$(OUTPUT).js: $(SOURCES) minimp3.h
	$(EMCC) $(EMFLAGS) $(SOURCES) -o $(OUTPUT).js

clean:
	rm -f $(OUTPUT).js $(OUTPUT).wasm
