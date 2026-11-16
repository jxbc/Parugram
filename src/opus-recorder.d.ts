declare module "opus-recorder" {
  export default class Recorder {
    constructor(options: {
      encoderPath: string
      numberOfChannels: number
      encoderApplication: number
      encoderSampleRate: number
      encoderBitRate: number
      mediaTrackConstraints: MediaTrackConstraints
    })
    ondataavailable: (data: Uint8Array | ArrayBuffer) => void
    onstop: () => void
    start(): Promise<void>
    stop(): Promise<void>
    close(): Promise<void>
  }
}

declare module "lottie-web/build/player/lottie_light" {
  import lottie from "lottie-web"
  export default lottie
}
