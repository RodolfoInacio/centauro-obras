// Modal genérico: backdrop escurecido + card centralizado. Sem lógica de negócio.
export default function Modal({ open, title, children, onClose, width = 380 }) {
  if (!open) return null;
  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: "#fff", borderRadius: 12, boxShadow: "0 10px 40px rgba(0,0,0,0.25)", padding: 22, width, maxWidth: "100%", boxSizing: "border-box" }}
      >
        {title && <div style={{ fontWeight: 800, fontSize: 15, color: "#1a1a1a", marginBottom: 14 }}>{title}</div>}
        {children}
      </div>
    </div>
  );
}
