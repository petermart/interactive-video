import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { apiFetch } from "./viewer";

const PANEL_WIDTH = 416;
const GUTTER = 12;

type Info = {
  title: string;
  text: string;
  pageUrl: string | null;
  videoUrl: string;
  verticalUrl: string | null;
  isPublic: boolean;
  /** False when the film only exists on the server's disk: downloadable, but no link can be handed out. */
  shareable: boolean;
  shareBlockedReason: string | null;
};

/** Brand marks, drawn simply enough to stay readable at 20px. */
const glyphs: Record<string, ReactNode> = {
  x: <path d="M3 3l7.6 9.6L3.4 21h2.2l6-6.6 5.2 6.6H21l-7.9-10L20.6 3h-2.2l-5.6 6.2L8.1 3H3z" />,
  facebook: <path d="M13.5 21v-7h2.4l.4-3h-2.8V9.1c0-.9.3-1.5 1.6-1.5h1.3V5c-.3 0-1.2-.1-2.3-.1-2.3 0-3.9 1.4-3.9 4V11H7.7v3h2.5v7h3.3z" />,
  linkedin: (
    <path d="M6.9 20H3.8V9.5h3.1V20zM5.3 8.1a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6zM20 20h-3.1v-5.1c0-1.2 0-2.8-1.7-2.8s-2 1.3-2 2.7V20H10V9.5h3v1.4h.1c.4-.8 1.5-1.6 3-1.6 3.2 0 3.8 2.1 3.8 4.9V20z" />
  ),
  reddit: (
    <g>
      <circle cx="12" cy="14" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="16.8" cy="4.4" r="1.5" />
      <path d="M12.6 7.6 15.6 4.9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="9.7" cy="13.4" r="1.1" />
      <circle cx="14.3" cy="13.4" r="1.1" />
      <path d="M9.3 16.6c1.6 1.2 3.8 1.2 5.4 0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </g>
  ),
  whatsapp: (
    <g fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3.5a8.5 8.5 0 0 0-7.2 13l-1.1 4 4.1-1.1A8.5 8.5 0 1 0 12 3.5z" />
      <path d="M9 9c0 3.3 2.7 6 6 6" />
    </g>
  ),
  telegram: <path d="M21.5 4 2.8 11.2l5 1.7 1.9 5.6 2.7-2.9 4.1 3.1L21.5 4zM8.6 12.6l8.6-5.3-6.7 6.6-.2 3.1-1.7-4.4z" />,
  instagram: (
    <g>
      <rect x="3.4" y="3.4" width="17.2" height="17.2" rx="5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="16.9" cy="7.1" r="1.2" />
    </g>
  ),
  tiktok: <path d="M14.2 3h3a5.4 5.4 0 0 0 4.3 4.4v3.1a8.4 8.4 0 0 1-4.3-1.4v5.6a6.1 6.1 0 1 1-6.1-6.1c.3 0 .7 0 1 .1v3.2a2.9 2.9 0 1 0 2 2.8V3z" />,
  youtube: <path d="M9.8 8.4 16.4 12l-6.6 3.6V8.4z" />,
};

type Target = { id: string; label: string; color: string; hint?: string };

/** Link shares: each opens that platform's composer with our share page. No API keys. */
const LINK_TARGETS: (Target & { href: (i: Info) => string })[] = [
  { id: "x", label: "X", color: "#000", href: i => `https://x.com/intent/tweet?text=${encodeURIComponent(i.text)}&url=${encodeURIComponent(i.pageUrl ?? "")}` },
  { id: "facebook", label: "Facebook", color: "#1877F2", href: i => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(i.pageUrl ?? "")}` },
  { id: "linkedin", label: "LinkedIn", color: "#0A66C2", href: i => `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(i.pageUrl ?? "")}` },
  { id: "reddit", label: "Reddit", color: "#FF4500", href: i => `https://www.reddit.com/submit?url=${encodeURIComponent(i.pageUrl ?? "")}&title=${encodeURIComponent(i.title)}` },
  { id: "whatsapp", label: "WhatsApp", color: "#25D366", href: i => `https://wa.me/?text=${encodeURIComponent(`${i.text} ${i.pageUrl ?? ""}`)}` },
  { id: "telegram", label: "Telegram", color: "#229ED9", href: i => `https://t.me/share/url?url=${encodeURIComponent(i.pageUrl ?? "")}&text=${encodeURIComponent(i.text)}` },
];

/** No keyless web share exists for these: save the cut they want, then open their upload page. */
const UPLOAD_TARGETS: (Target & { vertical: boolean; url: string })[] = [
  { id: "instagram", label: "Instagram", color: "#E1306C", hint: "9:16", vertical: true, url: "https://www.instagram.com/" },
  { id: "tiktok", label: "TikTok", color: "#111", hint: "9:16", vertical: true, url: "https://www.tiktok.com/upload" },
  { id: "youtube", label: "YouTube", color: "#FF0000", hint: "16:9", vertical: false, url: "https://studio.youtube.com/" },
];

/** True when this browser can put a real video file into the OS share sheet (phones). */
const canShareFiles = () => {
  try {
    const probe = new File([new Blob([new Uint8Array(1)])], "probe.mp4", { type: "video/mp4" });
    return Boolean(navigator.canShare?.({ files: [probe] }));
  } catch {
    return false;
  }
};

/**
 * One SHARE button. On phones it opens the OS share sheet with the actual MP4 (the only keyless route to
 * Instagram and TikTok); everywhere else it opens a compact icon carousel of composers, uploads and downloads.
 * The 9:16 cut is only rendered when something asks for it, so the landscape stitch isn't slowed down.
 */
export function ShareBar({ nodeId, outcome, accent }: { nodeId: string; outcome: string; accent: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<"preparing" | "ready" | "error">("preparing");
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>({});
  const menuRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const phone = canShareFiles();

  /** A mouse wheel has no horizontal axis, so drive the carousel with vertical scrolling. */
  useEffect(() => {
    const strip = stripRef.current;
    if (!open || !strip) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; // let trackpad swipes through untouched
      strip.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    strip.addEventListener("wheel", onWheel, { passive: false }); // React's own wheel handler is passive
    return () => strip.removeEventListener("wheel", onWheel);
  }, [open, info]);

  /** Sits just above the share button, flipping below it and clamping sideways when there isn't room. */
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = Math.min(PANEL_WIDTH, window.innerWidth - 2 * GUTTER);
      const height = menuRef.current?.offsetHeight ?? 190;
      const left = Math.min(Math.max(anchor.left + anchor.width / 2 - width / 2, GUTTER), window.innerWidth - width - GUTTER);
      const above = anchor.top - height - 10;
      setPlace({ width, left, top: above >= GUTTER ? above : Math.min(anchor.bottom + 10, window.innerHeight - height - GUTTER) });
    };
    position();
    const settle = requestAnimationFrame(position); // re-measure once the panel has its final width
    window.addEventListener("resize", position);
    return () => {
      cancelAnimationFrame(settle);
      window.removeEventListener("resize", position);
    };
  }, [open, info]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Landscape only: phones also need the vertical cut, so they ask for it up front.
        const res = await apiFetch(`/api/share/${nodeId}${phone ? "?vertical=1" : ""}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        if (cancelled) return;
        setInfo(body);
        if (phone) {
          // iOS cancels a share that waits on a download, so hold the file before the tap.
          const blob = await fetch(body.verticalUrl ?? body.videoUrl).then(r => r.blob());
          if (!cancelled) setFile(new File([blob], `escape-from-slop-prison-${outcome}.mp4`, { type: "video/mp4" }));
        }
        setStatus("ready");
      } catch (err) {
        if (!cancelled) {
          setNote((err as Error).message);
          setStatus("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nodeId]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // The button toggles on click, so ignore it here or it would close and immediately reopen.
      if (anchorRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  /** Renders the 9:16 cut on demand (Instagram, TikTok, the 9:16 download). */
  const ensureVertical = async () => {
    if (info?.verticalUrl) return info.verticalUrl;
    setNote("Making the 9:16 cut…");
    const res = await apiFetch(`/api/share/${nodeId}?vertical=1`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    setInfo(body);
    setNote("");
    return body.verticalUrl as string | null;
  };

  const save = (url: string | null, suffix: string) => {
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `escape-from-slop-prison-${outcome}${suffix}.mp4`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // A temporary film has done its job once the viewer has a copy; let the server reclaim it shortly after.
    if (info && !info.shareable) void apiFetch("/api/downloaded", { method: "POST", body: JSON.stringify({ url }) }).catch(() => {});
  };

  const primary = async () => {
    if (!info) return;
    if (!phone) return setOpen(o => !o);
    try {
      // Sharing the file itself is fine even for a temporary cut: the recipient gets bytes, not a link.
      if (file && navigator.canShare?.({ files: [file] })) return await navigator.share({ files: [file], title: info.title, text: info.text });
      if (navigator.share && info.pageUrl) return await navigator.share({ title: info.title, text: info.text, url: info.pageUrl });
      setOpen(o => !o);
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") setNote((err as Error).message);
    }
  };

  const run = (fn: () => Promise<void> | void) => async () => {
    try {
      await fn();
      setOpen(false);
    } catch (err) {
      setNote((err as Error).message);
    }
  };

  const busy = status === "preparing";
  const chip = "rounded-full border border-white/20 px-3 py-1 text-[11px] text-white/70 hover:border-white/50 hover:text-white";

  return (
    <div className="flex flex-col items-center gap-1">
      <div ref={anchorRef} className="flex items-center gap-2">
        <button
          onClick={primary}
          disabled={busy || !info}
          className={`rounded-md border px-6 py-3 font-display font-semibold tracking-widest backdrop-blur transition disabled:cursor-wait disabled:opacity-60 ${accent}`}
        >
          {busy ? "STITCHING YOUR FILM…" : phone ? "SHARE VIDEO" : "SHARE YOUR FILM"}
        </button>
        {phone && (
          <button
            onClick={() => setOpen(o => !o)}
            disabled={busy || !info}
            aria-label="More share options"
            className="rounded-md border border-white/20 bg-black/60 px-3 py-3 font-mono text-xs text-white/70 backdrop-blur disabled:opacity-40"
          >
            ⋯
          </button>
        )}
      </div>

      {note && <span className="font-mono text-[11px] text-white/60">{note}</span>}

      {open &&
        info &&
        createPortal(
          /* Portalled to <body>: our parent is translated, and a transformed ancestor would make this
             fixed panel position against that little box instead of the viewport. */
          <div
            ref={menuRef}
            role="dialog"
            aria-label="Share options"
            style={place}
            className="fixed z-[60] rounded-xl border border-white/15 bg-black/95 p-3 font-mono shadow-2xl backdrop-blur-md"
          >
            <div className="flex items-center justify-between pb-2">
              <span className="font-display text-[11px] tracking-[0.25em] text-white/60">SHARE YOUR FILM</span>
              <button onClick={() => setOpen(false)} aria-label="Close" className="px-1 text-lg leading-none text-white/40 hover:text-white">
                ×
              </button>
            </div>

            {/* Temporary cut: say so once, plainly, instead of offering links that would break. */}
            {!info.shareable && (
              <div className="mb-2 rounded border border-sodium/40 bg-sodium/10 p-2 text-[11px] leading-relaxed text-sodium">
                {info.shareBlockedReason ?? "This cut is temporary and can't be linked."}
              </div>
            )}

            {/* One horizontal strip: link composers first, then the platforms that need a manual upload. */}
            <div ref={stripRef} className="-mx-1 flex snap-x gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {/* Composers post a URL, so they are useless for a film that will not be there later. */}
              {info.shareable &&
                LINK_TARGETS.map(t => (
                  <Icon
                    key={t.id}
                    target={t}
                    onClick={run(() => void window.open(t.href(info as Info & { pageUrl: string }), "_blank", "noopener,noreferrer,width=600,height=640"))}
                  />
                ))}
              {/* Uploads send the actual file, so they keep working: the viewer's copy outlives ours. */}
              {UPLOAD_TARGETS.map(t => (
                <Icon
                  key={t.id}
                  target={t}
                  badge="↓"
                  onClick={run(async () => {
                    save(t.vertical ? await ensureVertical() : info.videoUrl, t.vertical ? "-vertical" : "");
                    window.open(t.url, "_blank", "noopener,noreferrer");
                  })}
                />
              ))}
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-white/10 pt-2">
              {info.shareable && info.pageUrl && (
                <button
                  className={chip}
                  onClick={run(async () => {
                    await navigator.clipboard.writeText(info.pageUrl!);
                    setNote("Link copied");
                  })}
                >
                  Copy link
                </button>
              )}
              <button className={chip} onClick={run(() => save(info.videoUrl, ""))}>
                Download 16:9
              </button>
              <button className={chip} onClick={run(async () => save(await ensureVertical(), "-vertical"))}>
                Download 9:16
              </button>
            </div>

            <p className="pt-2 text-[10px] leading-relaxed text-white/30">
              {info.isPublic
                ? "↓ saves the right cut, then opens that site's upload page."
                : "Local server: links only work on this machine. Downloads and uploads are fine."}
            </p>
          </div>,
          document.body,
        )}
    </div>
  );
}

function Icon({ target, onClick, badge }: { target: Target; onClick: () => void; badge?: string }) {
  return (
    <button
      onClick={onClick}
      title={target.hint ? `${target.label} — saves ${target.hint}` : target.label}
      className="group flex w-14 shrink-0 snap-start flex-col items-center gap-1 rounded-lg py-1 hover:bg-white/10"
    >
      <span className="relative grid size-10 place-items-center rounded-full text-white ring-1 ring-white/15" style={{ backgroundColor: target.color }}>
        <svg viewBox="0 0 24 24" className="size-5" fill="currentColor">
          {glyphs[target.id]}
        </svg>
        {badge && (
          <span className="absolute -bottom-0.5 -right-0.5 grid size-4 place-items-center rounded-full bg-black text-[9px] text-white/80 ring-1 ring-white/20">
            {badge}
          </span>
        )}
      </span>
      <span className="w-full truncate text-center text-[9px] text-white/45 group-hover:text-white/80">{target.label}</span>
    </button>
  );
}
