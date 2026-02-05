/*
 * Copyright (C) 2016 Bilibili. All Rights Reserved.
 *
 * @author zheng qian <xqq@xqq.im>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import Log from "../utils/logger.js";
import LoggingControl from "../utils/logging-control.js";
import TransmuxingController from "./transmuxing-controller.js";
import TransmuxingEvents from "./transmuxing-events";
import { WorkerAudioDecoder } from "../decoder/worker-audio-decoder";

/* post message to worker:
   data: {
       cmd: string
       param: any
   }

   receive message from worker:
   data: {
       msg: string,
       data: any
   }
 */

let TAG = "TransmuxingWorker";
let controller = null;
let audioDecoder = null;
let softDecodeConfig = null;
let logcatListener = onLogcatCallback.bind(this);

self.addEventListener("message", function (e) {
  switch (e.data.cmd) {
    case "init":
      // Save config for audio decoder
      const config = e.data.param[1];
      softDecodeConfig = {
        wasmPath: config.softDecodeWasmPath || "/wasm/",
      };
      controller = new TransmuxingController(e.data.param[0], config);
      controller.on(TransmuxingEvents.IO_ERROR, onIOError.bind(this));
      controller.on(TransmuxingEvents.DEMUX_ERROR, onDemuxError.bind(this));
      controller.on(TransmuxingEvents.INIT_SEGMENT, onInitSegment.bind(this));
      controller.on(TransmuxingEvents.MEDIA_SEGMENT, onMediaSegment.bind(this));
      controller.on(
        TransmuxingEvents.LOADING_COMPLETE,
        onLoadingComplete.bind(this)
      );
      controller.on(
        TransmuxingEvents.RECOVERED_EARLY_EOF,
        onRecoveredEarlyEof.bind(this)
      );
      controller.on(TransmuxingEvents.MEDIA_INFO, onMediaInfo.bind(this));
      controller.on(
        TransmuxingEvents.METADATA_ARRIVED,
        onMetaDataArrived.bind(this)
      );
      controller.on(
        TransmuxingEvents.SCRIPTDATA_ARRIVED,
        onScriptDataArrived.bind(this)
      );
      controller.on(
        TransmuxingEvents.TIMED_ID3_METADATA_ARRIVED,
        onTimedID3MetadataArrived.bind(this)
      );
      controller.on(
        TransmuxingEvents.PGS_SUBTITLE_ARRIVED,
        onPGSSubtitleDataArrived.bind(this)
      );
      controller.on(
        TransmuxingEvents.SYNCHRONOUS_KLV_METADATA_ARRIVED,
        onSynchronousKLVMetadataArrived.bind(this)
      );
      controller.on(
        TransmuxingEvents.ASYNCHRONOUS_KLV_METADATA_ARRIVED,
        onAsynchronousKLVMetadataArrived.bind(this)
      );
      controller.on(
        TransmuxingEvents.SMPTE2038_METADATA_ARRIVED,
        onSMPTE2038MetadataArrived.bind(this)
      );
      controller.on(
        TransmuxingEvents.SCTE35_METADATA_ARRIVED,
        onSCTE35MetadataArrived.bind(this)
      );
      controller.on(
        TransmuxingEvents.PES_PRIVATE_DATA_DESCRIPTOR,
        onPESPrivateDataDescriptor.bind(this)
      );
      controller.on(
        TransmuxingEvents.PES_PRIVATE_DATA_ARRIVED,
        onPESPrivateDataArrived.bind(this)
      );
      controller.on(
        TransmuxingEvents.STATISTICS_INFO,
        onStatisticsInfo.bind(this)
      );
      controller.on(
        TransmuxingEvents.RECOMMEND_SEEKPOINT,
        onRecommendSeekpoint.bind(this)
      );
      controller.on(
        TransmuxingEvents.RAW_AUDIO_DATA,
        onRawAudioData.bind(this)
      );
      break;
    case "destroy":
      if (audioDecoder) {
        audioDecoder.destroy();
        audioDecoder = null;
      }
      if (controller) {
        controller.destroy();
        controller = null;
      }
      self.postMessage({ msg: "destroyed" });
      break;
    case "start":
      controller.start();
      break;
    case "stop":
      controller.stop();
      break;
    case "seek":
      controller.seek(e.data.param);
      break;
    case "pause":
      controller.pause();
      break;
    case "resume":
      controller.resume();
      break;
    case "logging_config": {
      let config = e.data.param;
      LoggingControl.applyConfig(config);

      if (config.enableCallback === true) {
        LoggingControl.addLogListener(logcatListener);
      } else {
        LoggingControl.removeLogListener(logcatListener);
      }
      break;
    }
    case "soft_decode_mode":
      if (controller) {
        controller.setSoftDecodeMode(e.data.param);
      }
      break;
    case "init_audio_decoder":
      // Initialize audio decoder in worker with config
      softDecodeConfig = e.data.param;
      break;
  }
});

function onInitSegment(type, initSegment) {
  let obj = {
    msg: TransmuxingEvents.INIT_SEGMENT,
    data: {
      type: type,
      data: initSegment,
    },
  };
  self.postMessage(obj, [initSegment.data]); // data: ArrayBuffer
}

function onMediaSegment(type, mediaSegment) {
  let obj = {
    msg: TransmuxingEvents.MEDIA_SEGMENT,
    data: {
      type: type,
      data: mediaSegment,
    },
  };
  self.postMessage(obj, [mediaSegment.data]); // data: ArrayBuffer
}

function onLoadingComplete() {
  let obj = {
    msg: TransmuxingEvents.LOADING_COMPLETE,
  };
  self.postMessage(obj);
}

function onRecoveredEarlyEof() {
  let obj = {
    msg: TransmuxingEvents.RECOVERED_EARLY_EOF,
  };
  self.postMessage(obj);
}

function onMediaInfo(mediaInfo) {
  let obj = {
    msg: TransmuxingEvents.MEDIA_INFO,
    data: mediaInfo,
  };
  self.postMessage(obj);
}

function onMetaDataArrived(metadata) {
  let obj = {
    msg: TransmuxingEvents.METADATA_ARRIVED,
    data: metadata,
  };
  self.postMessage(obj);
}

function onScriptDataArrived(data) {
  let obj = {
    msg: TransmuxingEvents.SCRIPTDATA_ARRIVED,
    data: data,
  };
  self.postMessage(obj);
}

function onTimedID3MetadataArrived(data) {
  let obj = {
    msg: TransmuxingEvents.TIMED_ID3_METADATA_ARRIVED,
    data: data,
  };
  self.postMessage(obj);
}

function onPGSSubtitleDataArrived(data) {
  let obj = {
    msg: TransmuxingEvents.PGS_SUBTITLE_ARRIVED,
    data: data,
  };
  self.postMessage(obj);
}

function onSynchronousKLVMetadataArrived(data) {
  let obj = {
    msg: TransmuxingEvents.SYNCHRONOUS_KLV_METADATA_ARRIVED,
    data: data,
  };
  self.postMessage(obj);
}

function onAsynchronousKLVMetadataArrived(data) {
  let obj = {
    msg: TransmuxingEvents.ASYNCHRONOUS_KLV_METADATA_ARRIVED,
    data: data,
  };
  self.postMessage(obj);
}

function onSMPTE2038MetadataArrived(data) {
  let obj = {
    msg: TransmuxingEvents.SMPTE2038_METADATA_ARRIVED,
    data: data,
  };
  self.postMessage(obj);
}

function onSCTE35MetadataArrived(data) {
  let obj = {
    msg: TransmuxingEvents.SCTE35_METADATA_ARRIVED,
    data: data,
  };
  self.postMessage(obj);
}

function onPESPrivateDataDescriptor(data) {
  let obj = {
    msg: TransmuxingEvents.PES_PRIVATE_DATA_DESCRIPTOR,
    data: data,
  };
  self.postMessage(obj);
}

function onPESPrivateDataArrived(data) {
  let obj = {
    msg: TransmuxingEvents.PES_PRIVATE_DATA_ARRIVED,
    data: data,
  };
  self.postMessage(obj);
}

function onStatisticsInfo(statInfo) {
  let obj = {
    msg: TransmuxingEvents.STATISTICS_INFO,
    data: statInfo,
  };
  self.postMessage(obj);
}

function onIOError(type, info) {
  self.postMessage({
    msg: TransmuxingEvents.IO_ERROR,
    data: {
      type: type,
      info: info,
    },
  });
}

function onDemuxError(type, info) {
  self.postMessage({
    msg: TransmuxingEvents.DEMUX_ERROR,
    data: {
      type: type,
      info: info,
    },
  });
}

function onRecommendSeekpoint(milliseconds) {
  self.postMessage({
    msg: TransmuxingEvents.RECOMMEND_SEEKPOINT,
    data: milliseconds,
  });
}

function onLogcatCallback(type, str) {
  self.postMessage({
    msg: "logcat_callback",
    data: {
      type: type,
      logcat: str,
    },
  });
}

// Track pending decoder initialization to avoid duplicate init calls
let audioDecoderInitPending = false;
let audioDecoderInitCodec = null;

async function onRawAudioData(frame) {
  // Determine codec from frame
  const codec = frame.codec || "mp2";

  // Initialize audio decoder if not already done
  if (!audioDecoder) {
    const wasmPath = softDecodeConfig?.wasmPath || "/wasm/";
    audioDecoder = new WorkerAudioDecoder({ wasmPath });
  }

  // Initialize decoder for this codec if needed (only once)
  if (audioDecoder && !audioDecoder.isActive() && !audioDecoderInitPending) {
    audioDecoderInitPending = true;
    audioDecoderInitCodec = codec;
    const success = await audioDecoder.initDecoder(codec);
    audioDecoderInitPending = false;
    if (!success) {
      Log.w(TAG, `Failed to initialize audio decoder for ${codec}`);
      return;
    }
  }

  // If initialization is pending, skip this frame
  if (audioDecoderInitPending) {
    return;
  }

  // Decode audio in worker
  if (audioDecoder && audioDecoder.isActive()) {
    const pcmData = audioDecoder.decode(frame.data, frame.pts);
    if (pcmData) {
      // Send decoded PCM data to main thread
      let obj = {
        msg: TransmuxingEvents.PCM_AUDIO_DATA,
        data: pcmData,
      };
      // Transfer the PCM buffer to avoid copy
      self.postMessage(obj, [pcmData.pcm.buffer]);
      return;
    }
  }

  // Fallback: send raw audio data to main thread (for backwards compatibility)
  let obj = {
    msg: TransmuxingEvents.RAW_AUDIO_DATA,
    data: frame,
  };
  if (frame.data && frame.data.buffer) {
    self.postMessage(obj, [frame.data.buffer]);
  } else {
    self.postMessage(obj);
  }
}
