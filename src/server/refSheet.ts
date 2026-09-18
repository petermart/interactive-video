/**
 * Labeled reference sheet: several reference images packed into one 16:9 image, for video endpoints that only
 * take a first frame (fal's H3 Max turbo). The prompt tells the model the first frame is a reference sheet and to
 * jump cut away from it straight away, so the sheet is on screen for a single frame and trimmed off afterwards.
 *
 * Holds the environment plus up to 8 more references (9 in all, the same budget as H3 reference-to-video), with
 * the grid picked by how many there are so no cell is left empty where it can be avoided (black bands tend to
 * leak into the generated shots):
 * - 1-3 others: the environment fills the left two-thirds, the others stack in the right column;
 * - 4-5 others: 3x3 grid, the environment takes the top-left 2x2;
 * - 6-8 others: 4x3 grid, the environment takes the top-left 2x2, the others fill the right half and bottom row.
 * Entries are placed in the order given, so the most important references (protagonist first) sit top-right.
 */

export type SheetEntry = { label: string; image: string };

const W = 1662;
const H = 936;
/** Environment + this many more: the same 9-image budget as H3 reference-to-video. */
export const SHEET_MAX_OTHERS = 8;

// drawtext needs a real font file. The Docker image installs fonts-dejavu-core for this.
const FONT =
  process.platform === "win32"
    ? "C\\:/Windows/Fonts/arialbd.ttf"
    : process.platform === "darwin"
      ? "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
      : "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

type Cell = { x: number; y: number; w: number; h: number };

/** The environment's area and the cells for everything else, for `n` other entries. */
function layout(n: number): { environment: Cell; cells: Cell[]; labelSize: number } {
  const grid = (cols: number, rows: number, order: [number, number][]) => {
    const cw = W / cols;
    const ch = H / rows;
    return order.map(([c, r]) => ({ x: Math.round(c * cw), y: Math.round(r * ch), w: Math.round(cw), h: Math.round(ch) }));
  };
  if (n <= 3) {
    return { environment: { x: 0, y: 0, w: Math.round((2 * W) / 3), h: H }, cells: grid(3, 3, [[2, 0], [2, 1], [2, 2]]), labelSize: 24 };
  }
  if (n <= 5) {
    return {
      environment: { x: 0, y: 0, w: Math.round((2 * W) / 3), h: Math.round((2 * H) / 3) },
      cells: grid(3, 3, [[2, 0], [2, 1], [2, 2], [0, 2], [1, 2]]),
      labelSize: 24,
    };
  }
  return {
    environment: { x: 0, y: 0, w: Math.round(W / 2), h: Math.round((2 * H) / 3) },
    cells: grid(4, 3, [[2, 0], [3, 0], [2, 1], [3, 1], [2, 2], [3, 2], [0, 2], [1, 2]]),
    labelSize: 20,
  };
}

/** drawtext escaping: backslash, colon and percent are special, and a straight quote would end the argument. */
const esc = (t: string) => t.replace(/\\/g, "\\\\").replace(/'/g, "\u2019").replace(/:/g, "\\:").replace(/%/g, "\\%");

/** Renders the sheet to `out` (JPEG). The environment is cropped to fill its area; everything else is fitted whole. */
export async function buildSheet(environment: SheetEntry, others: SheetEntry[], out: string) {
  const rest = others.slice(0, SHEET_MAX_OTHERS);
  const plan = layout(rest.length);
  const placed = [
    { entry: environment, cell: plan.environment, cover: true, size: 34 },
    ...rest.map((entry, i) => ({ entry, cell: plan.cells[i]!, cover: false, size: plan.labelSize })),
  ];

  const args = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}`];
  for (const p of placed) args.push("-i", p.entry.image);
  const filters: string[] = [];
  placed.forEach(({ entry, cell: c, cover, size }, i) => {
    const fit = cover
      ? `scale=${c.w - 8}:${c.h - 8}:force_original_aspect_ratio=increase,crop=${c.w - 8}:${c.h - 8},pad=${c.w}:${c.h}:4:4:color=black`
      : `scale=${c.w - 8}:${c.h - 8}:force_original_aspect_ratio=decrease,pad=${c.w}:${c.h}:(ow-iw)/2:(oh-ih)/2:color=black`;
    const label = `drawtext=fontfile='${FONT}':text='${esc(entry.label)}':x=10:y=10:fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.75:boxborderw=8`;
    filters.push(`[${i + 1}:v]${fit},${label}[c${i}]`);
  });
  let last = "0:v";
  placed.forEach(({ cell }, i) => {
    filters.push(`[${last}][c${i}]overlay=${cell.x}:${cell.y}[o${i}]`);
    last = `o${i}`;
  });
  args.push("-filter_complex", filters.join(";"), "-map", `[${last}]`, "-frames:v", "1", "-q:v", "3", out);

  const proc = Bun.spawn(args, { stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(`ffmpeg failed building the reference sheet: ${stderr.trim().slice(-500)}`);
  return out;
}
