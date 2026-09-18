import { generateVideo as generateTurbo } from "./falTurboVideo";
import type { VideoRequest } from "./machgen";

/**
 * "Turbo Half" provider: fal H3 Max turbo at half length, prompted as a 2x fast-forward and played at half speed.
 * Half the cost of Turbo, same references (the labeled sheet), 12 real frames per second. See falTurboVideo.ts.
 */
export { uploadAsset, uploadFile } from "./falTurboVideo";

export const generateVideo = (req: VideoRequest) => generateTurbo(req, { halfSpeed: true });
