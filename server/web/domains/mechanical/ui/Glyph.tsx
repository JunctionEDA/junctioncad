// Glyph.tsx — a 24×24 stroke icon given as inline SVG markup (a feature's or a tool's `icon`).
export function Glyph({ svg, size = 18 }: { svg?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="flex-none fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round]"
      strokeWidth={1.7} dangerouslySetInnerHTML={{ __html: svg || '<rect x="5" y="5" width="14" height="14" rx="2"/>' }} />
  );
}
