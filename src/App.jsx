import { useState, useEffect, useMemo, useCallback } from "react";
import { S, Auth, supabase } from "./supabase.js";

// ── Utilities ──
const uid = () => Math.random().toString(36).slice(2, 10);
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const fd = (d) => d.toISOString().split("T")[0];
const ft = (h, m) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
const pt = (s) => { const [h, m] = s.split(":").map(Number); return { h, m }; };
const sanitize = (str) => {
  if (typeof str !== "string") return "";
  return str.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c])).slice(0, 1000);
};
const rateLimiter = (() => {
  const attempts = {};
  return (key, max = 5, windowMs = 60000) => {
    const now = Date.now();
    if (!attempts[key]) attempts[key] = [];
    attempts[key] = attempts[key].filter((t) => now - t < windowMs);
    if (attempts[key].length >= max) return false;
    attempts[key].push(now);
    return true;
  };
})();

// ── Notification System ──
const renderTemplate = (tpl, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] || "");
const DEFAULT_TEMPLATES = {
  confirmation: { subject: "Booking Confirmed - {{salonName}}", body: "Hi {{clientName}}, your {{serviceName}} with {{staffName}} on {{date}} at {{time}} is confirmed." },
  reminder: { subject: "Reminder: {{serviceName}} tomorrow", body: "Hi {{clientName}}, reminder: {{serviceName}} with {{staffName}} tomorrow at {{time}} at {{salonName}}." },
  cancellation: { subject: "Booking Cancelled - {{salonName}}", body: "Hi {{clientName}}, your {{serviceName}} on {{date}} at {{time}} has been cancelled." },
  waitlist: { subject: "Slot Available! - {{salonName}}", body: "Hi {{clientName}}, a slot opened for {{serviceName}} on {{date}}. Book now before it's taken!" },
  review_request: { subject: "How was your visit? - {{salonName}}", body: "Hi {{clientName}}, how was your {{serviceName}} with {{staffName}}? Leave a review!" },
};
const mockSend = async (n) => {
  console.log(`[MOCK ${n.channel?.toUpperCase()}] To: ${n.recipient_email || n.recipient_phone} | ${n.subject}`);
  return { success: true };
};
const queueNotification = async (salon, setSalon, notif) => {
  const entry = { id: uid(), salon_id: salon.id, ...notif, status: "queued", created_at: new Date().toISOString() };
  const u = { ...salon, notifications: [entry, ...(salon.notifications || [])] };
  await S.saveFullSalon(u);
  setSalon(u);
  setTimeout(async () => {
    await mockSend(entry);
    entry.status = "sent"; entry.sent_at = new Date().toISOString();
    const updated = { ...u, notifications: (u.notifications || []).map((n) => n.id === entry.id ? entry : n) };
    await S.saveFullSalon(updated);
    setSalon(updated);
  }, 300);
};

// ── Calendar Sync ──
const generateICS = (booking, salon) => {
  const svc = salon.services.find((s) => s.id === booking.serviceId);
  const staff = salon.staff.find((s) => s.id === booking.staffId);
  const sh = Math.floor(booking.startMin / 60), sm = booking.startMin % 60;
  const em = booking.startMin + (svc?.duration || 30);
  const eh = Math.floor(em / 60), emin = em % 60;
  const ds = booking.date.replace(/-/g, "");
  const dtS = `${ds}T${ft(sh, sm).replace(":", "")}00`;
  const dtE = `${ds}T${ft(eh, emin).replace(":", "")}00`;
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//BookApp//EN", "BEGIN:VEVENT",
    `UID:${booking.id}@bookapp`, `DTSTART:${dtS}`, `DTEND:${dtE}`,
    `SUMMARY:${svc?.name || "Appointment"} at ${salon.name}`,
    `DESCRIPTION:${svc?.name} with ${staff?.name}\\nPrice: ${svc?.price}`,
    `LOCATION:${salon.address || salon.name}`, "STATUS:CONFIRMED",
    `ORGANIZER:MAILTO:${salon.email}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
};
const downloadICS = (booking, salon) => {
  const blob = new Blob([generateICS(booking, salon)], { type: "text/calendar;charset=utf-8" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `booking-${booking.id}.ics`; a.click(); URL.revokeObjectURL(a.href);
};
const downloadAllICS = (bookings, salon) => {
  const events = bookings.map((b) => {
    const svc = salon.services.find((s) => s.id === b.serviceId);
    const staff = salon.staff.find((s) => s.id === b.staffId);
    const sh = Math.floor(b.startMin / 60), sm = b.startMin % 60;
    const em = b.startMin + (svc?.duration || 30);
    const eh = Math.floor(em / 60), emin = em % 60;
    const ds = b.date.replace(/-/g, "");
    return `BEGIN:VEVENT\r\nUID:${b.id}@bookapp\r\nDTSTART:${ds}T${ft(sh, sm).replace(":", "")}00\r\nDTEND:${ds}T${ft(eh, emin).replace(":", "")}00\r\nSUMMARY:${svc?.name || "Appointment"} at ${salon.name}\r\nDESCRIPTION:${svc?.name} with ${staff?.name}\r\nLOCATION:${salon.address || ""}\r\nEND:VEVENT`;
  }).join("\r\n");
  const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//BookApp//EN\r\n${events}\r\nEND:VCALENDAR`;
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `all-bookings.ics`; a.click(); URL.revokeObjectURL(a.href);
};
const googleCalUrl = (booking, salon) => {
  const svc = salon.services.find((s) => s.id === booking.serviceId);
  const staff = salon.staff.find((s) => s.id === booking.staffId);
  const sh = Math.floor(booking.startMin / 60), sm = booking.startMin % 60;
  const em = booking.startMin + (svc?.duration || 30);
  const eh = Math.floor(em / 60), emin = em % 60;
  const ds = booking.date.replace(/-/g, "");
  const params = new URLSearchParams({ action: "TEMPLATE", text: `${svc?.name} at ${salon.name}`, dates: `${ds}T${ft(sh, sm).replace(":", "")}00/${ds}T${ft(eh, emin).replace(":", "")}00`, details: `${svc?.name} with ${staff?.name}. Price: ${svc?.price}`, location: salon.address || "" });
  return `https://calendar.google.com/calendar/render?${params}`;
};

// ── Dynamic PWA Manifest ──
const generateSalonIcon = (salon, size = 192) => {
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  const ctx = c.getContext("2d");
  // Background with salon color
  ctx.fillStyle = salon.color || "#1a1a2e";
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, size * 0.2);
  ctx.fill();
  if (salon.logo?.startsWith("data:")) {
    // Return promise for image-based logo
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const pad = size * 0.15;
        const s = Math.min((size - pad * 2) / img.width, (size - pad * 2) / img.height);
        const w = img.width * s, h = img.height * s;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        c.toBlob((blob) => resolve(URL.createObjectURL(blob)), "image/png");
      };
      img.src = salon.logo;
    });
  }
  // Emoji logo
  ctx.font = `${size * 0.5}px serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(salon.logo || "\u2702\uFE0F", size / 2, size / 2 + size * 0.03);
  return new Promise((resolve) => {
    c.toBlob((blob) => resolve(URL.createObjectURL(blob)), "image/png");
  });
};

const setSalonManifest = async (salon) => {
  const icon192 = await generateSalonIcon(salon, 192);
  const icon512 = await generateSalonIcon(salon, 512);
  const manifest = {
    name: salon.name,
    short_name: salon.name,
    description: salon.tagline || "Book with " + salon.name,
    start_url: window.location.origin + "/#salon:" + salon.id,
    display: "standalone",
    background_color: salon.color || "#0a0a0a",
    theme_color: salon.color || "#0a0a0a",
    orientation: "portrait",
    icons: [
      { src: icon192, sizes: "192x192", type: "image/png" },
      { src: icon512, sizes: "512x512", type: "image/png" },
    ],
  };
  const blob = new Blob([JSON.stringify(manifest)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  // Replace existing manifest link
  let link = document.querySelector('link[rel="manifest"]');
  if (link) { link.href = url; } else { link = document.createElement("link"); link.rel = "manifest"; link.href = url; document.head.appendChild(link); }
  // Update theme color and title
  document.title = salon.name + " - Book Now";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = salon.color || "#0a0a0a";
  // Update apple-touch-icon
  let appleIcon = document.querySelector('link[rel="apple-touch-icon"]');
  if (!appleIcon) { appleIcon = document.createElement("link"); appleIcon.rel = "apple-touch-icon"; document.head.appendChild(appleIcon); }
  appleIcon.href = icon192;
  // Update apple-mobile-web-app-title for iOS home screen name
  let appTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
  if (!appTitle) { appTitle = document.createElement("meta"); appTitle.name = "apple-mobile-web-app-title"; document.head.appendChild(appTitle); }
  appTitle.content = salon.name;
};

const resetManifest = () => {
  const link = document.querySelector('link[rel="manifest"]');
  if (link) link.href = "/manifest.json";
  document.title = "Book.app";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = "#0a0a0a";
};

// ── Data Export ──
const toCSV = (data, columns) => {
  const hdr = columns.map((c) => c.label).join(",");
  const rows = data.map((row) => columns.map((c) => { const v = c.getter ? c.getter(row) : row[c.key] || ""; const s = String(v).replace(/"/g, '""'); return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s}"` : s; }).join(","));
  return [hdr, ...rows].join("\n");
};
const downloadFile = (content, filename, type = "text/csv;charset=utf-8;") => {
  const blob = new Blob([content], { type }); const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename; a.click(); URL.revokeObjectURL(a.href);
};

// ── Slot Calculator ──
function getSlots(salon, staffId, svcId, ds) {
  const d = new Date(ds + "T00:00:00"), dk = DAYS[d.getDay()], hrs = salon.hours[dk];
  if (!hrs || hrs === "Closed" || salon.holidays?.includes(ds)) return [];
  if ((salon.staffHolidays || []).some((h) => h.staffId === staffId && h.dates?.includes(ds))) return [];
  // Check staff availability overrides
  const staffMember = salon.staff.find((s) => s.id === staffId);
  if (staffMember?.availability?.[ds]) {
    const av = staffMember.availability[ds];
    if (!av.available) return [];
    if (av.customHours) {
      const [os, cs] = av.customHours.split("-"), o = pt(os), c = pt(cs);
      const om = o.h * 60 + o.m, cm = c.h * 60 + c.m;
      const svc = salon.services.find((s) => s.id === svcId);
      if (!svc) return [];
      const slots = [];
      for (let t = om; t + svc.duration <= cm; t += 15) {
        if (!salon.bookings?.some((b) => b.staffId === staffId && b.date === ds && !(t >= b.startMin + b.duration || t + svc.duration <= b.startMin))) slots.push(t);
      }
      return slots;
    }
  }
  const svc = salon.services.find((s) => s.id === svcId);
  if (!svc) return [];
  const [os, cs] = hrs.split("-"), o = pt(os), c = pt(cs), om = o.h * 60 + o.m, cm = c.h * 60 + c.m, slots = [];
  for (let t = om; t + svc.duration <= cm; t += 15) {
    if (!salon.bookings?.some((b) => b.staffId === staffId && b.date === ds && !(t >= b.startMin + b.duration || t + svc.duration <= b.startMin))) slots.push(t);
  }
  return slots;
}

// ── Waitlist Check ──
const checkWaitlist = async (salon, setSalon, cancelledBooking) => {
  const wl = (salon.waitlist || []).filter((w) => w.status === "waiting" && w.preferred_date === cancelledBooking.date && (w.staff_id === cancelledBooking.staffId || !w.staff_id) && w.service_id === cancelledBooking.serviceId).sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
  if (wl.length > 0) {
    const first = wl[0];
    const expiry = new Date(Date.now() + 30 * 60000).toISOString();
    const u = { ...salon, waitlist: (salon.waitlist || []).map((w) => w.id === first.id ? { ...w, status: "notified", notified_at: new Date().toISOString(), expires_at: expiry } : w) };
    const svc = salon.services.find((s) => s.id === first.service_id);
    await queueNotification(u, setSalon, {
      type: "waitlist", channel: "email",
      recipient_email: first.client_email, recipient_name: first.client_name,
      subject: renderTemplate(DEFAULT_TEMPLATES.waitlist.subject, { salonName: salon.name }),
      body: renderTemplate(DEFAULT_TEMPLATES.waitlist.body, { clientName: first.client_name, serviceName: svc?.name || "", date: first.preferred_date, salonName: salon.name }),
      booking_id: cancelledBooking.id,
    });
  }
};

// ── Shared UI Components ──
const Ic = ({ n, sz = 20 }) => {
  const paths = { back: "M19 12H5M12 19l-7-7 7-7", check: "M20 6L9 17l-5-5", plus: "M12 5v14M5 12h14", trash: "M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2", x: "M18 6L6 18M6 6l12 12", send: "M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z", bell: "M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0", calendar: "M16 2v4M8 2v4M3 10h18", clock: "M12 6v6l4 2", users: "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2", settings: "M12 1v2m0 18v2m-9-11h2m18 0h2", scissors: "M20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12", chart: "M18 20V10M12 20V4M6 20v-6", phone: "M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6A19.79 19.79 0 012.12 4.18 2 2 0 014.11 2h3", star: "M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.27 5.82 22 7 14.14 2 9.27l6.91-1.01L12 2z", grid: "", home: "M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z", download: "M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3", list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01", eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z", shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" };
  const d = paths[n]; if (!d) return null;
  return <svg width={sz} height={sz} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">{n === "clock" && <circle cx="12" cy="12" r="10" />}{n === "calendar" && <rect x="3" y="4" width="18" height="18" rx="2" />}{n === "eye" && <circle cx="12" cy="12" r="3" />}<path d={d} /></svg>;
};
const Stars = ({ rating, sz = 16, onRate, color = "#f59e0b" }) => (
  <div style={{ display: "flex", gap: 2 }}>{[1, 2, 3, 4, 5].map((i) => (
    <svg key={i} width={sz} height={sz} viewBox="0 0 24 24" fill={i <= rating ? color : "none"} stroke={color} strokeWidth="2" style={{ cursor: onRate ? "pointer" : "default" }} onClick={() => onRate?.(i)}>
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.27 5.82 22 7 14.14 2 9.27l6.91-1.01L12 2z" />
    </svg>))}
  </div>
);
const Pill = ({ children, active, onClick, color }) => <button onClick={onClick} style={{ padding: "8px 18px", borderRadius: 100, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: "inherit", background: active ? (color || "#111") : "rgba(0,0,0,0.06)", color: active ? "#fff" : "#555" }}>{children}</button>;
const Modal = ({ children, onClose, title }) => <div style={{ position: "fixed", inset: 0, zIndex: 999, display: "flex", alignItems: "center", justifyContent: "center" }}><div onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)" }} /><div style={{ position: "relative", background: "#fff", borderRadius: 20, width: "min(95vw,480px)", maxHeight: "85vh", overflow: "auto", padding: 28 }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}><h3 style={{ margin: 0, fontSize: 18, fontFamily: "'DM Sans',sans-serif" }}>{title}</h3><button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}><Ic n="x" /></button></div>{children}</div></div>;
const Inp = ({ label, ...p }) => <div style={{ marginBottom: 16 }}>{label && <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#777", marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>{label}</label>}<input {...p} style={{ width: "100%", padding: "12px 14px", border: "2px solid #eee", borderRadius: 12, fontSize: 15, fontFamily: "inherit", outline: "none", boxSizing: "border-box", color: "#222", background: "#fff", ...(p.style || {}) }} /></div>;
const Btn = ({ children, variant = "primary", color, onClick, style, disabled, full }) => <button disabled={disabled} onClick={onClick} style={{ padding: "13px 24px", borderRadius: 12, border: variant === "outline" ? "2px solid " + (color || "#ddd") : "none", background: disabled ? "#ccc" : variant === "primary" ? (color || "#111") : "transparent", color: variant === "primary" ? "#fff" : (color || "#111"), fontSize: 14, fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer", fontFamily: "inherit", width: full ? "100%" : "auto", ...style }}>{children}</button>;
const Av = ({ src, sz = 44, bg = "#eee" }) => src?.startsWith("data:") ? <img src={src} style={{ width: sz, height: sz, borderRadius: sz * .28, objectFit: "cover" }} /> : <div style={{ width: sz, height: sz, borderRadius: sz * .28, background: bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: sz * .5 }}>{src || "\uD83E\uDDD1"}</div>;
const readImg = (file, cb) => { const r = new FileReader(); r.onload = (e) => { const img = new Image(); img.onload = () => { const c = document.createElement("canvas"), mx = 128, s = Math.min(mx / img.width, mx / img.height, 1); c.width = img.width * s; c.height = img.height * s; c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); cb(c.toDataURL("image/jpeg", 0.7)); }; img.src = e.target.result; }; r.readAsDataURL(file); };

// ── Demo Data ──
const DEMO = {
  "luxe-cuts": { id: "luxe-cuts", name: "Luxe Cuts", tagline: "Premium grooming", color: "#1a1a2e", accent: "#e94560", logo: "\u2702\uFE0F", phone: "+44 7700 900123", email: "hello@luxecuts.com", address: "London", hours: { mon: "09:00-18:00", tue: "09:00-18:00", wed: "09:00-20:00", thu: "09:00-20:00", fri: "09:00-18:00", sat: "09:00-17:00", sun: "Closed" }, staff: [{ id: "s1", name: "James", role: "Senior Barber", avatar: "\uD83E\uDDD1", color: "#e94560" }, { id: "s2", name: "Maria", role: "Stylist", avatar: "\uD83E\uDDD1", color: "#0f3460" }, { id: "s3", name: "Alex", role: "Junior", avatar: "\uD83E\uDDD1", color: "#533483" }], services: [{ id: "sv1", name: "Classic Cut", duration: 30, price: 25, category: "Haircuts" }, { id: "sv2", name: "Skin Fade", duration: 45, price: 30, category: "Haircuts" }, { id: "sv3", name: "Beard Trim", duration: 20, price: 15, category: "Grooming" }, { id: "sv4", name: "Hot Towel Shave", duration: 40, price: 35, category: "Grooming" }, { id: "sv5", name: "Cut & Beard", duration: 60, price: 40, category: "Packages" }], holidays: [], outOfHours: { enabled: true, slots: [{ hour: 18, surcharge: 5 }, { hour: 19, surcharge: 10 }] }, bookings: [{ id: "b01", serviceId: "sv1", staffId: "s1", date: "2026-03-25", startMin: 570, duration: 30, clientName: "Tom Wilson", clientPhone: "+44 7700 111", clientEmail: "tom@email.com" }, { id: "b02", serviceId: "sv2", staffId: "s2", date: "2026-03-30", startMin: 600, duration: 45, clientName: "Sarah Chen", clientPhone: "+44 7700 333", clientEmail: "sarah@email.com" }, { id: "b03", serviceId: "sv5", staffId: "s1", date: "2026-04-01", startMin: 660, duration: 60, clientName: "Mike Davis", clientPhone: "+44 7700 555", clientEmail: "mike@email.com" }, { id: "b05", serviceId: "sv1", staffId: "s1", date: "2026-04-08", startMin: 540, duration: 30, clientName: "Tom Wilson", clientPhone: "+44 7700 111", clientEmail: "tom@email.com" }, { id: "b06", serviceId: "sv2", staffId: "s2", date: "2026-04-08", startMin: 600, duration: 45, clientName: "Sarah Chen", clientPhone: "+44 7700 333", clientEmail: "sarah@email.com" }, { id: "b07", serviceId: "sv3", staffId: "s3", date: "2026-04-08", startMin: 690, duration: 20, clientName: "Jake Morris", clientPhone: "+44 7700 202", clientEmail: "jake@email.com" }, { id: "b08", serviceId: "sv1", staffId: "s1", date: "2026-04-09", startMin: 570, duration: 30, clientName: "Mike Davis", clientPhone: "+44 7700 555", clientEmail: "mike@email.com" }, { id: "b09", serviceId: "sv5", staffId: "s2", date: "2026-04-10", startMin: 600, duration: 60, clientName: "Tom Wilson", clientPhone: "+44 7700 111", clientEmail: "tom@email.com" }, { id: "b10", serviceId: "sv2", staffId: "s3", date: "2026-04-11", startMin: 540, duration: 45, clientName: "Sarah Chen", clientPhone: "+44 7700 333", clientEmail: "sarah@email.com" }, { id: "b11", serviceId: "sv1", staffId: "s1", date: "2026-04-14", startMin: 600, duration: 30, clientName: "Jake Morris", clientPhone: "+44 7700 202", clientEmail: "jake@email.com" }, { id: "b12", serviceId: "sv4", staffId: "s2", date: "2026-04-16", startMin: 570, duration: 40, clientName: "Mike Davis", clientPhone: "+44 7700 555", clientEmail: "mike@email.com" }, { id: "b13", serviceId: "sv5", staffId: "s3", date: "2026-04-20", startMin: 660, duration: 60, clientName: "Tom Wilson", clientPhone: "+44 7700 111", clientEmail: "tom@email.com" }], clients: [{ id: "c1", name: "Tom Wilson", phone: "+44 7700 111", email: "tom@email.com", visits: 12, lastVisit: "2026-04-08", noShows: 0 }, { id: "c2", name: "Sarah Chen", phone: "+44 7700 333", email: "sarah@email.com", visits: 5, lastVisit: "2026-04-02", noShows: 0 }, { id: "c3", name: "Mike Davis", phone: "+44 7700 555", email: "mike@email.com", visits: 8, lastVisit: "2026-04-06", noShows: 1 }, { id: "c4", name: "Jake Morris", phone: "+44 7700 202", email: "jake@email.com", visits: 6, lastVisit: "2026-03-30", noShows: 0 }], reviews: [{ id: "r1", bookingId: "b01", clientEmail: "tom@email.com", clientName: "Tom Wilson", staffId: "s1", serviceId: "sv1", rating: 5, text: "Best cut in town! James is incredibly skilled.", createdAt: "2026-03-26T10:00:00Z", ownerResponse: "Thanks Tom! Always a pleasure.", ownerRespondedAt: "2026-03-26T14:00:00Z", hidden: false }, { id: "r2", bookingId: "b02", clientEmail: "sarah@email.com", clientName: "Sarah Chen", staffId: "s2", serviceId: "sv2", rating: 4, text: "Great fade, very happy with the result.", createdAt: "2026-03-31T09:00:00Z", ownerResponse: null, ownerRespondedAt: null, hidden: false }], waitlist: [], notifications: [], notificationTemplates: [], oohRequests: [], staffHolidays: [], messageLog: [], campaigns: [{ id: "camp1", type: "reminder", icon: "\uD83D\uDD14", title: "Appointment Reminder", trigger: "1 day before", msg: "Don't forget your appointment tomorrow!", active: true }], notificationSettings: { reminderHours: [24, 2], confirmations: true, cancellationNotify: true, waitlistNotify: true } },
  "glow-studio": { id: "glow-studio", name: "Glow Studio", tagline: "Beauty destination", color: "#2d1b2e", accent: "#f4a261", logo: "\uD83D\uDC85", phone: "+44 7700 900456", email: "book@glowstudio.com", address: "Brighton", hours: { mon: "10:00-19:00", tue: "10:00-19:00", wed: "10:00-21:00", thu: "10:00-21:00", fri: "10:00-19:00", sat: "09:00-18:00", sun: "11:00-16:00" }, staff: [{ id: "s1", name: "Sophie", role: "Lead Therapist", avatar: "\uD83E\uDDD1", color: "#f4a261" }, { id: "s2", name: "Emma", role: "Nail Tech", avatar: "\uD83E\uDDD1", color: "#e76f51" }], services: [{ id: "sv1", name: "Gel Manicure", duration: 45, price: 35, category: "Nails" }, { id: "sv2", name: "Acrylics", duration: 75, price: 55, category: "Nails" }, { id: "sv3", name: "Facial", duration: 60, price: 50, category: "Skincare" }, { id: "sv4", name: "Lash Extensions", duration: 90, price: 70, category: "Lashes" }], holidays: [], outOfHours: { enabled: true, slots: [{ hour: 19, surcharge: 8 }, { hour: 20, surcharge: 12 }] }, bookings: [{ id: "gb01", serviceId: "sv1", staffId: "s1", date: "2026-04-01", startMin: 600, duration: 45, clientName: "Emily Rose", clientPhone: "+44 7700 777", clientEmail: "emily@email.com" }, { id: "gb02", serviceId: "sv3", staffId: "s2", date: "2026-04-08", startMin: 660, duration: 60, clientName: "Olivia James", clientPhone: "+44 7700 888", clientEmail: "olivia@email.com" }, { id: "gb03", serviceId: "sv1", staffId: "s1", date: "2026-04-08", startMin: 600, duration: 45, clientName: "Emily Rose", clientPhone: "+44 7700 777", clientEmail: "emily@email.com" }, { id: "gb04", serviceId: "sv2", staffId: "s2", date: "2026-04-09", startMin: 600, duration: 75, clientName: "Chloe Brown", clientPhone: "+44 7700 121", clientEmail: "chloe@email.com" }, { id: "gb05", serviceId: "sv4", staffId: "s1", date: "2026-04-10", startMin: 660, duration: 90, clientName: "Emily Rose", clientPhone: "+44 7700 777", clientEmail: "emily@email.com" }, { id: "gb06", serviceId: "sv1", staffId: "s2", date: "2026-04-14", startMin: 600, duration: 45, clientName: "Olivia James", clientPhone: "+44 7700 888", clientEmail: "olivia@email.com" }, { id: "gb07", serviceId: "sv3", staffId: "s1", date: "2026-04-16", startMin: 720, duration: 60, clientName: "Chloe Brown", clientPhone: "+44 7700 121", clientEmail: "chloe@email.com" }], clients: [{ id: "c1", name: "Emily Rose", phone: "+44 7700 777", email: "emily@email.com", visits: 20, lastVisit: "2026-04-08", noShows: 0 }, { id: "c2", name: "Olivia James", phone: "+44 7700 888", email: "olivia@email.com", visits: 9, lastVisit: "2026-04-08", noShows: 0 }, { id: "c3", name: "Chloe Brown", phone: "+44 7700 121", email: "chloe@email.com", visits: 6, lastVisit: "2026-04-06", noShows: 1 }], reviews: [{ id: "r3", bookingId: "gb01", clientEmail: "emily@email.com", clientName: "Emily Rose", staffId: "s1", serviceId: "sv1", rating: 5, text: "Sophie does amazing gel nails every time!", createdAt: "2026-04-02T11:00:00Z", ownerResponse: null, ownerRespondedAt: null, hidden: false }], waitlist: [], notifications: [], notificationTemplates: [], oohRequests: [], staffHolidays: [], messageLog: [], campaigns: [], notificationSettings: { reminderHours: [24], confirmations: true, cancellationNotify: true, waitlistNotify: true } },
};

// ══════════════════════════════════════════════════
// ── CUSTOMER APP ──
// ══════════════════════════════════════════════════
const CustomerApp = ({ salon, setSalon }) => {
  const [step, setStep] = useState("home"); const [selSvc, setSelSvc] = useState(null); const [selStaff, setSelStaff] = useState(null); const [selDate, setSelDate] = useState(null); const [selTime, setSelTime] = useState(null);
  const [cName, setCName] = useState(""); const [cPhone, setCPhone] = useState(""); const [loggedIn, setLoggedIn] = useState(false); const [authEmail, setAuthEmail] = useState(""); const [authPw, setAuthPw] = useState(""); const [authName, setAuthName] = useState(""); const [authMode, setAuthMode] = useState("login"); const [authErr, setAuthErr] = useState(""); const [editBk, setEditBk] = useState(null); const [cancelId, setCancelId] = useState(null);
  const [oohReq, setOohReq] = useState({ svcId: "", date: "", time: "", note: "" });
  const [reviewBk, setReviewBk] = useState(null); const [reviewRating, setReviewRating] = useState(0); const [reviewText, setReviewText] = useState("");
  const [wlPref, setWlPref] = useState("any");
  const a = salon.accent, bg = salon.color, today = new Date(), todayS = fd(today);

  useEffect(() => { (async () => { const s = await S.getSession("cs:" + salon.id); if (s?.loggedIn) { setCName(s.name || ""); setCPhone(s.phone || ""); setAuthEmail(s.email || ""); setLoggedIn(true); } else { setCName("Demo User"); setAuthEmail("demo@example.com"); setLoggedIn(true); await S.setSession("cs:" + salon.id, { loggedIn: true, name: "Demo User", phone: "", email: "demo@example.com" }); } })(); }, [salon.id]);

  const cats = useMemo(() => { const c = {}; salon.services.forEach((s) => { (c[s.category] = c[s.category] || []).push(s); }); return c; }, [salon]);
  const dates = useMemo(() => Array.from({ length: 21 }, (_, i) => { const d = new Date(today); d.setDate(d.getDate() + i); return d; }), []);
  const slots = useMemo(() => !selDate || !selStaff || !selSvc ? [] : getSlots(salon, selStaff.id, selSvc.id, fd(selDate)), [salon, selStaff, selSvc, selDate]);
  const myBk = useMemo(() => loggedIn ? (salon.bookings || []).filter((b) => (authEmail && b.clientEmail === authEmail) || (cPhone && b.clientPhone === cPhone)).sort((x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : x.startMin - y.startMin) : [], [salon.bookings, authEmail, cPhone, loggedIn]);
  const myUp = myBk.filter((b) => b.date >= todayS);
  const myPast = myBk.filter((b) => b.date < todayS);
  const myWl = useMemo(() => (salon.waitlist || []).filter((w) => (authEmail && w.client_email === authEmail) || (cPhone && w.client_phone === cPhone)), [salon.waitlist, authEmail, cPhone]);
  const avgRating = useMemo(() => { const rv = (salon.reviews || []).filter((r) => !r.hidden); if (!rv.length) return null; return (rv.reduce((s, r) => s + r.rating, 0) / rv.length).toFixed(1); }, [salon.reviews]);

  const book = async () => {
    const bk = { id: uid(), serviceId: selSvc.id, staffId: selStaff.id, date: fd(selDate), startMin: selTime, duration: selSvc.duration, clientName: sanitize(cName), clientPhone: cPhone, clientEmail: authEmail?.toLowerCase() || "", createdAt: new Date().toISOString() };
    const u = { ...salon, bookings: [...(salon.bookings || []), bk] };
    const em = authEmail?.toLowerCase();
    if (em && !u.clients?.find((c) => c.email === em)) u.clients = [...(u.clients || []), { id: uid(), name: cName, phone: cPhone, email: em, visits: 1, lastVisit: fd(today), noShows: 0 }];
    await S.saveFullSalon(u); setSalon(u); setStep("done");
    // Queue confirmation notification
    if (salon.notificationSettings?.confirmations !== false) {
      const tpl = DEFAULT_TEMPLATES.confirmation;
      await queueNotification(u, setSalon, { type: "confirmation", channel: "email", recipient_email: bk.clientEmail, recipient_name: bk.clientName, subject: renderTemplate(tpl.subject, { salonName: salon.name }), body: renderTemplate(tpl.body, { clientName: bk.clientName, serviceName: selSvc.name, staffName: selStaff.name, date: bk.date, time: ft(Math.floor(selTime / 60), selTime % 60), salonName: salon.name }), booking_id: bk.id });
    }
  };

  const cancelBk = async (id) => {
    const cancelled = salon.bookings.find((b) => b.id === id);
    const u = { ...salon, bookings: salon.bookings.filter((b) => b.id !== id) };
    await S.saveFullSalon(u); setSalon(u); setCancelId(null);
    // Queue cancellation notification
    if (cancelled && salon.notificationSettings?.cancellationNotify !== false) {
      const svc = salon.services.find((s) => s.id === cancelled.serviceId);
      const tpl = DEFAULT_TEMPLATES.cancellation;
      await queueNotification(u, setSalon, { type: "cancellation", channel: "email", recipient_email: cancelled.clientEmail, recipient_name: cancelled.clientName, subject: renderTemplate(tpl.subject, { salonName: salon.name }), body: renderTemplate(tpl.body, { clientName: cancelled.clientName, serviceName: svc?.name || "", date: cancelled.date, time: ft(Math.floor(cancelled.startMin / 60), cancelled.startMin % 60), salonName: salon.name }), booking_id: id });
    }
    // Check waitlist
    if (cancelled && salon.notificationSettings?.waitlistNotify !== false) {
      await checkWaitlist(u, setSalon, cancelled);
    }
  };

  const signOut = async () => { setCName(""); setCPhone(""); setLoggedIn(false); setAuthEmail(""); await S.delSession("cs:" + salon.id); };

  const doLogin = async () => {
    setAuthErr(""); if (!authEmail || !authPw) return setAuthErr("Enter email and password.");
    if (!rateLimiter("login:" + authEmail)) return setAuthErr("Too many attempts. Wait a minute.");
    const ac = await S.getAccount("ac:" + salon.id + ":" + authEmail.toLowerCase());
    if (!ac) return setAuthErr("No account found."); if (ac.password !== authPw) return setAuthErr("Wrong password.");
    setCName(ac.name); setCPhone(ac.phone || ""); setLoggedIn(true);
    await S.setSession("cs:" + salon.id, { loggedIn: true, name: ac.name, phone: ac.phone || "", email: ac.email }); setStep("home");
  };

  const doReg = async () => {
    setAuthErr(""); if (!authName || !authEmail || !authPw) return setAuthErr("Fill all fields."); if (authPw.length < 6) return setAuthErr("Password min 6 chars.");
    const ex = await S.getAccount("ac:" + salon.id + ":" + authEmail.toLowerCase());
    if (ex) return setAuthErr("Account exists.");
    await S.setAccount("ac:" + salon.id + ":" + authEmail.toLowerCase(), { name: authName, email: authEmail.toLowerCase(), phone: cPhone, password: authPw });
    setCName(authName); setLoggedIn(true);
    await S.setSession("cs:" + salon.id, { loggedIn: true, name: authName, phone: cPhone, email: authEmail.toLowerCase() }); setStep("home");
  };

  const submitOoh = async () => {
    if (!oohReq.svcId || !oohReq.date || !oohReq.time) return;
    const r = { id: uid(), clientName: cName, clientEmail: authEmail?.toLowerCase() || "", clientPhone: cPhone, serviceId: oohReq.svcId, requestedDate: oohReq.date, requestedTime: oohReq.time, note: sanitize(oohReq.note), status: "pending", createdAt: new Date().toISOString() };
    const u = { ...salon, oohRequests: [...(salon.oohRequests || []), r] };
    await S.saveFullSalon(u); setSalon(u); setOohReq({ svcId: "", date: "", time: "", note: "" }); setStep("ooh-sent");
  };

  const respondOoh = async (reqId, accept) => {
    const u = { ...salon, oohRequests: (salon.oohRequests || []).map((r) => r.id === reqId ? { ...r, status: accept ? "accepted" : "rejected" } : r) };
    if (accept) { const r = (salon.oohRequests || []).find((x) => x.id === reqId); if (r) { const svc = salon.services.find((s) => s.id === r.serviceId); const [h, m] = (r.quotedTime || r.requestedTime).split(":").map(Number); u.bookings = [...(u.bookings || []), { id: uid(), serviceId: r.serviceId, staffId: salon.staff[0]?.id || "", date: r.requestedDate, startMin: h * 60 + m, duration: svc?.duration || 30, clientName: r.clientName, clientPhone: r.clientPhone || "", clientEmail: r.clientEmail || "", surcharge: r.quotedPrice ? (r.quotedPrice - (svc?.price || 0)) : 0, createdAt: new Date().toISOString(), addedBy: "ooh" }]; } }
    await S.saveFullSalon(u); setSalon(u);
  };

  const submitReview = async () => {
    if (!reviewBk || !reviewRating) return;
    const rv = { id: uid(), bookingId: reviewBk.id, clientEmail: authEmail?.toLowerCase() || "", clientName: cName, staffId: reviewBk.staffId, serviceId: reviewBk.serviceId, rating: reviewRating, text: sanitize(reviewText), createdAt: new Date().toISOString(), ownerResponse: null, ownerRespondedAt: null, hidden: false };
    const u = { ...salon, reviews: [...(salon.reviews || []), rv] };
    await S.saveFullSalon(u); setSalon(u); setReviewBk(null); setReviewRating(0); setReviewText("");
  };

  const joinWaitlist = async () => {
    if (!selSvc || !selStaff || !selDate) return;
    const entry = { id: uid(), salon_id: salon.id, client_name: cName, client_email: authEmail?.toLowerCase() || "", client_phone: cPhone, staff_id: selStaff.id, service_id: selSvc.id, preferred_date: fd(selDate), preferred_time_range: { from: wlPref, to: wlPref }, status: "waiting", created_at: new Date().toISOString() };
    const u = { ...salon, waitlist: [...(salon.waitlist || []), entry] };
    await S.saveFullSalon(u); setSalon(u); setStep("wl-done");
  };

  const myOoh = useMemo(() => (salon.oohRequests || []).filter((r) => (authEmail && r.clientEmail === authEmail.toLowerCase()) || (cPhone && r.clientPhone === cPhone)), [salon.oohRequests, authEmail, cPhone]);
  const Hdr = ({ title, onBack }) => <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "20px 0", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>{onBack && <button onClick={onBack} style={{ background: "rgba(255,255,255,0.1)", border: "none", borderRadius: 10, padding: 8, cursor: "pointer", color: "#fff", display: "flex" }}><Ic n="back" sz={18} /></button>}<span style={{ fontSize: 16, fontWeight: 700, color: "#fff" }}>{title}</span></div>;
  const CalBtns = ({ bk }) => <div style={{ display: "flex", gap: 6, marginTop: 8 }}><button onClick={() => downloadICS(bk, salon)} style={{ background: "rgba(255,255,255,0.08)", border: "none", borderRadius: 8, padding: "5px 10px", color: "#fff", fontSize: 11, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4 }}><Ic n="calendar" sz={12} />iCal</button><a href={googleCalUrl(bk, salon)} target="_blank" rel="noopener" style={{ background: "rgba(255,255,255,0.08)", borderRadius: 8, padding: "5px 10px", color: "#fff", fontSize: 11, textDecoration: "none", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4 }}><Ic n="calendar" sz={12} />Google</a></div>;

  if (step === "done") return (
    <div style={{ minHeight: "100vh", background: bg, color: "#fff", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 32, textAlign: "center", fontFamily: "'DM Sans',sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700;800&family=Playfair+Display:wght@700&display=swap" rel="stylesheet" />
      <div style={{ width: 80, height: 80, borderRadius: "50%", background: a, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 24 }}><Ic n="check" sz={36} /></div>
      <h2 style={{ margin: 0, fontSize: 24 }}>Booking Confirmed!</h2>
      <p style={{ opacity: .7, marginTop: 8 }}>{selSvc?.name} with {selStaff?.name}<br />{selDate?.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}<br />{selTime != null && ft(Math.floor(selTime / 60), selTime % 60)}</p>
      <div style={{ display: "flex", gap: 10, marginTop: 20, flexWrap: "wrap", justifyContent: "center" }}>
        <button onClick={() => { const bk = salon.bookings[salon.bookings.length - 1]; if (bk) downloadICS(bk, salon); }} style={{ padding: "10px 18px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.2)", background: "transparent", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6 }}><Ic n="calendar" sz={16} />Add to Calendar</button>
        <a href={salon.bookings?.length ? googleCalUrl(salon.bookings[salon.bookings.length - 1], salon) : "#"} target="_blank" rel="noopener" style={{ padding: "10px 18px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.2)", background: "transparent", color: "#fff", fontSize: 13, fontWeight: 600, textDecoration: "none", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6 }}><Ic n="calendar" sz={16} />Google Calendar</a>
      </div>
      <Btn color={a} onClick={() => { setStep("home"); setSelSvc(null); setSelStaff(null); setSelDate(null); setSelTime(null); }} style={{ marginTop: 28 }}>Back to Home</Btn>
    </div>
  );

  if (step === "wl-done") return (
    <div style={{ minHeight: "100vh", background: bg, color: "#fff", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 32, textAlign: "center", fontFamily: "'DM Sans',sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700;800&family=Playfair+Display:wght@700&display=swap" rel="stylesheet" />
      <div style={{ width: 80, height: 80, borderRadius: "50%", background: "#f0ad4e22", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 24 }}><Ic n="bell" sz={32} /></div>
      <h2 style={{ margin: "0 0 8px", fontSize: 22 }}>Added to Waitlist!</h2>
      <p style={{ opacity: .5, fontSize: 14, lineHeight: 1.6, margin: "0 0 24px", maxWidth: 300 }}>We'll notify you if a slot opens up for {selSvc?.name} on {selDate?.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}.</p>
      <Btn color={a} onClick={() => { setStep("home"); setSelSvc(null); setSelStaff(null); setSelDate(null); setSelTime(null); }} style={{ borderRadius: 14 }}>Back to Home</Btn>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: bg, color: "#fff", fontFamily: "'DM Sans',sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700;800&family=Playfair+Display:wght@700&display=swap" rel="stylesheet" />
      <style>{"@keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}.fade-up{animation:fadeUp .4s ease forwards}::-webkit-scrollbar{display:none}"}</style>
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "0 20px" }}>

        {step === "home" && <div className="fade-up">
          {loggedIn && <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 16, marginBottom: -20 }}><div style={{ display: "flex", alignItems: "center", gap: 10 }}><div style={{ width: 32, height: 32, borderRadius: 8, background: a, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 800, color: "#fff" }}>{(cName || "G")[0].toUpperCase()}</div><div style={{ fontSize: 13, fontWeight: 600 }}>Hi, {cName?.split(" ")[0]}</div></div><button onClick={signOut} style={{ background: "rgba(255,255,255,0.08)", border: "none", color: "rgba(255,255,255,0.4)", borderRadius: 8, padding: "5px 12px", fontSize: 11, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}>Sign Out</button></div>}
          <div style={{ paddingTop: loggedIn ? 24 : 48, textAlign: "center" }}>{salon.logo?.startsWith("data:") ? <img src={salon.logo} style={{ width: 72, height: 72, borderRadius: 18, objectFit: "cover", marginBottom: 12 }} /> : <div style={{ fontSize: 56, marginBottom: 12 }}>{salon.logo}</div>}<h1 style={{ margin: 0, fontSize: 32, fontFamily: "'Playfair Display',serif", fontWeight: 700 }}>{salon.name}</h1><p style={{ opacity: .6, margin: "8px 0 0", fontSize: 15 }}>{salon.tagline}</p>
            {avgRating && <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 8 }}><Stars rating={Math.round(Number(avgRating))} sz={16} /><span style={{ fontSize: 14, fontWeight: 600 }}>{avgRating}</span><span style={{ fontSize: 12, opacity: .4 }}>({(salon.reviews || []).filter((r) => !r.hidden).length} reviews)</span></div>}
          </div>
          <Btn full color={a} onClick={() => setStep("services")} style={{ marginTop: 36, fontSize: 16, padding: "16px 24px", borderRadius: 16 }}>Book Appointment</Btn>
          <button onClick={() => setStep("bookings")} style={{ marginTop: 12, width: "100%", padding: "14px 20px", borderRadius: 14, border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.04)", color: "#fff", cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}><Ic n="calendar" sz={18} />My Bookings{myUp.length > 0 && <span style={{ background: a, color: "#fff", fontSize: 11, fontWeight: 800, padding: "2px 8px", borderRadius: 20 }}>{myUp.length}</span>}</button>
          <button onClick={() => setStep("reviews")} style={{ marginTop: 8, width: "100%", padding: "14px 20px", borderRadius: 14, border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.04)", color: "#fff", cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}><Ic n="star" sz={18} />Reviews</button>
          {salon.outOfHours?.enabled && <button onClick={() => setStep("ooh-request")} style={{ marginTop: 8, width: "100%", padding: "14px 20px", borderRadius: 14, border: "1px solid rgba(240,173,78,0.25)", background: "rgba(240,173,78,0.06)", color: "#f0ad4e", cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}><Ic n="clock" sz={18} />Request Out-of-Hours</button>}
          <button onClick={async () => {
            // Ensure manifest is set for this salon before prompting
            await setSalonManifest(salon);
            const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
            const isAndroid = /android/i.test(navigator.userAgent);
            if (window.matchMedia('(display-mode: standalone)').matches) {
              alert("You're already using " + salon.name + " from your home screen!");
            } else if (isAndroid && window._deferredPrompt) {
              window._deferredPrompt.prompt();
              window._deferredPrompt.userChoice.then(() => { window._deferredPrompt = null; });
            } else if (isIOS) {
              alert("Add " + salon.name + " to your home screen:\n\n1. Tap the Share button (square with arrow)\n2. Scroll down and tap 'Add to Home Screen'\n3. It will appear as '" + salon.name + "' with the salon logo");
            } else if (isAndroid) {
              alert("Add " + salon.name + " to your home screen:\n\n1. Tap the menu (\u22EE)\n2. Tap 'Add to Home Screen'\n3. It will appear as '" + salon.name + "' with the salon logo");
            } else {
              alert("Add " + salon.name + " to your home screen:\n\nOpen this page on your mobile device, then use the browser menu to 'Add to Home Screen'. It will save as '" + salon.name + "' with the salon logo.");
            }
          }} style={{ marginTop: 8, width: "100%", padding: "14px 20px", borderRadius: 14, border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.04)", color: "#fff", cursor: "pointer", fontFamily: "inherit", fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}><Ic n="home" sz={18} />Add {salon.name} to Home Screen</button>
          {myOoh.filter((r) => r.status === "quoted").map((r) => { const svc = salon.services.find((s) => s.id === r.serviceId); return <div key={r.id} style={{ marginTop: 10, background: "rgba(99,102,241,0.1)", borderRadius: 14, padding: "14px 16px", border: "1px solid rgba(99,102,241,0.25)" }}><div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 2, opacity: .5, fontWeight: 700, marginBottom: 6, color: "#6366f1" }}>Quote Received</div><div style={{ fontWeight: 700, fontSize: 14 }}>{svc?.name} - {r.requestedDate}</div><div style={{ fontSize: 13, opacity: .6, marginTop: 4 }}>Price: <span style={{ fontWeight: 700, color: "#fff" }}>{r.quotedPrice}</span> at {r.quotedTime}</div><div style={{ display: "flex", gap: 8, marginTop: 12 }}><button onClick={() => respondOoh(r.id, true)} style={{ flex: 1, padding: "10px", borderRadius: 10, border: "none", background: "#2ec4b6", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Accept & Book</button><button onClick={() => respondOoh(r.id, false)} style={{ flex: 1, padding: "10px", borderRadius: 10, border: "1px solid rgba(231,76,60,0.3)", background: "transparent", color: "#e74c3c", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Decline</button></div></div>; })}
          {myWl.filter((w) => w.status === "notified").map((w) => { const svc = salon.services.find((s) => s.id === w.service_id); return <div key={w.id} style={{ marginTop: 10, background: "rgba(46,196,182,0.1)", borderRadius: 14, padding: "14px 16px", border: "1px solid rgba(46,196,182,0.25)" }}><div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 2, fontWeight: 700, marginBottom: 6, color: "#2ec4b6" }}>Slot Available!</div><div style={{ fontWeight: 700, fontSize: 14 }}>{svc?.name} - {w.preferred_date}</div><div style={{ fontSize: 12, opacity: .5, marginTop: 4 }}>A slot opened up! Book now before it expires.</div><Btn full color="#2ec4b6" onClick={() => { setSelSvc(salon.services.find((s) => s.id === w.service_id)); setStep("staff"); }} style={{ marginTop: 10, borderRadius: 10, padding: "10px", fontSize: 13 }}>Book Now</Btn></div>; })}
          <div style={{ height: 40 }} />
        </div>}

        {step === "reviews" && <div className="fade-up">
          <Hdr title="Reviews" onBack={() => setStep("home")} />
          <div style={{ paddingTop: 16 }}>
            {avgRating && <div style={{ textAlign: "center", marginBottom: 20 }}><div style={{ fontSize: 36, fontWeight: 800 }}>{avgRating}</div><Stars rating={Math.round(Number(avgRating))} sz={24} /><div style={{ fontSize: 12, opacity: .4, marginTop: 4 }}>{(salon.reviews || []).filter((r) => !r.hidden).length} reviews</div></div>}
            {(salon.reviews || []).filter((r) => !r.hidden).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).map((r) => {
              const staff = salon.staff.find((s) => s.id === r.staffId);
              const svc = salon.services.find((s) => s.id === r.serviceId);
              return <div key={r.id} style={{ background: "rgba(255,255,255,0.05)", borderRadius: 14, padding: 16, marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}><div><div style={{ fontWeight: 700, fontSize: 14 }}>{r.clientName}</div><div style={{ fontSize: 11, opacity: .4 }}>{svc?.name} with {staff?.name}</div></div><Stars rating={r.rating} sz={14} /></div>
                {r.text && <div style={{ fontSize: 13, opacity: .7, lineHeight: 1.5 }}>{r.text}</div>}
                {r.ownerResponse && <div style={{ marginTop: 10, background: "rgba(255,255,255,0.05)", borderRadius: 10, padding: 12 }}><div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 1, opacity: .4, fontWeight: 700, marginBottom: 4 }}>Owner Response</div><div style={{ fontSize: 13, opacity: .7 }}>{r.ownerResponse}</div></div>}
              </div>;
            })}
            {!(salon.reviews || []).filter((r) => !r.hidden).length && <div style={{ textAlign: "center", opacity: .3, padding: 40, fontSize: 14 }}>No reviews yet</div>}
          </div>
        </div>}

        {step === "bookings" && <div className="fade-up">
          <Hdr title="My Bookings" onBack={() => setStep("home")} />
          {!loggedIn ? <div style={{ padding: "40px 0", textAlign: "center" }}>
            <p style={{ opacity: .5, marginBottom: 16, fontSize: 14 }}>Sign in to see your bookings</p>
            <Btn color={a} onClick={() => setStep("auth")}>Sign In</Btn>
          </div> : <>
            <div style={{ paddingTop: 16 }}>
              {myUp.length === 0 && <div style={{ textAlign: "center", opacity: .3, padding: "30px 0", fontSize: 14 }}>No upcoming bookings</div>}
              {myUp.map((b) => { const svc = salon.services.find((s) => s.id === b.serviceId); const stf = salon.staff.find((s) => s.id === b.staffId); return <div key={b.id} style={{ background: "rgba(255,255,255,0.06)", borderRadius: 16, padding: 16, marginBottom: 12, border: "1px solid rgba(255,255,255,0.06)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}><div><div style={{ fontWeight: 700, fontSize: 15 }}>{svc?.name}</div><div style={{ fontSize: 13, opacity: .5, marginTop: 4 }}>with {stf?.name}</div><div style={{ fontSize: 13, opacity: .5 }}>{new Date(b.date + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} at {ft(Math.floor(b.startMin / 60), b.startMin % 60)}</div></div><div style={{ display: "flex", gap: 6 }}><button onClick={() => setCancelId(b.id)} style={{ background: "rgba(231,76,60,0.1)", border: "none", borderRadius: 8, padding: "6px 12px", color: "#e74c3c", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Cancel</button></div></div>
                <CalBtns bk={b} />
              </div>; })}
            </div>
            {/* Waitlist entries */}
            {myWl.length > 0 && <div style={{ marginTop: 20 }}><div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 2, opacity: .3, fontWeight: 700, marginBottom: 12 }}>Waitlist</div>
              {myWl.map((w) => { const svc = salon.services.find((s) => s.id === w.service_id); return <div key={w.id} style={{ background: "rgba(240,173,78,0.08)", borderRadius: 14, padding: 14, marginBottom: 8, border: "1px solid rgba(240,173,78,0.15)" }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div><div style={{ fontWeight: 600, fontSize: 14 }}>{svc?.name}</div><div style={{ fontSize: 12, opacity: .5 }}>{w.preferred_date}</div></div><span style={{ fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 20, background: w.status === "notified" ? "rgba(46,196,182,0.15)" : "rgba(240,173,78,0.15)", color: w.status === "notified" ? "#2ec4b6" : "#f0ad4e" }}>{w.status}</span></div></div>; })}
            </div>}
            {/* Past bookings with review option */}
            {myPast.length > 0 && <div style={{ marginTop: 20 }}><div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 2, opacity: .3, fontWeight: 700, marginBottom: 12 }}>Past</div>
              {myPast.slice(0, 10).map((b) => { const svc = salon.services.find((s) => s.id === b.serviceId); const stf = salon.staff.find((s) => s.id === b.staffId); const hasReview = (salon.reviews || []).some((r) => r.bookingId === b.id); return <div key={b.id} style={{ background: "rgba(255,255,255,0.03)", borderRadius: 14, padding: 14, marginBottom: 8, opacity: .6 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div><div style={{ fontWeight: 600, fontSize: 14 }}>{svc?.name} with {stf?.name}</div><div style={{ fontSize: 12, opacity: .5 }}>{b.date}</div></div>
                  {hasReview ? <span style={{ fontSize: 11, color: "#2ec4b6", fontWeight: 600 }}>Reviewed</span> : <button onClick={() => { setReviewBk(b); setReviewRating(0); setReviewText(""); }} style={{ background: a + "22", border: "none", borderRadius: 8, padding: "5px 12px", color: a, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Review</button>}
                </div>
              </div>; })}
            </div>}
          </>}
        </div>}

        {step === "auth" && <div className="fade-up">
          <Hdr title={authMode === "login" ? "Sign In" : "Create Account"} onBack={() => setStep("home")} />
          <div style={{ paddingTop: 20 }}>
            {authMode === "register" && <Inp label="Name" value={authName} onChange={(e) => setAuthName(e.target.value)} style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#fff" }} />}
            <Inp label="Email" type="email" value={authEmail} onChange={(e) => { setAuthEmail(e.target.value); setAuthErr(""); }} style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#fff" }} />
            <Inp label="Password" type="password" value={authPw} onChange={(e) => { setAuthPw(e.target.value); setAuthErr(""); }} style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#fff" }} />
            {authErr && <div style={{ background: "rgba(231,76,60,0.1)", borderRadius: 10, padding: "10px 14px", marginBottom: 12, fontSize: 13, color: "#e74c3c" }}>{authErr}</div>}
            <Btn full color={a} onClick={authMode === "login" ? doLogin : doReg} style={{ borderRadius: 14 }}>{authMode === "login" ? "Sign In" : "Create Account"}</Btn>
            <p style={{ fontSize: 12, opacity: .4, textAlign: "center", marginTop: 14 }}>{authMode === "login" ? "No account? " : "Have account? "}<button onClick={() => { setAuthMode(authMode === "login" ? "register" : "login"); setAuthErr(""); }} style={{ background: "none", border: "none", color: a, cursor: "pointer", fontFamily: "inherit", fontWeight: 600, fontSize: 12 }}>{authMode === "login" ? "Register" : "Sign In"}</button></p>
          </div>
        </div>}

        {step === "services" && <div className="fade-up">
          <Hdr title="Select Service" onBack={() => setStep("home")} />
          {Object.entries(cats).map(([cat, svcs]) => <div key={cat} style={{ marginTop: 20 }}><div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 2, opacity: .3, fontWeight: 700, marginBottom: 10 }}>{cat}</div>{svcs.map((s) => <button key={s.id} onClick={() => { setSelSvc(s); setStep("staff"); }} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 18px", borderRadius: 14, border: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.04)", cursor: "pointer", marginBottom: 8, color: "#fff", fontFamily: "inherit" }}><div style={{ textAlign: "left" }}><div style={{ fontWeight: 700, fontSize: 15 }}>{s.name}</div><div style={{ fontSize: 12, opacity: .4, marginTop: 2 }}>{s.duration} min</div></div><div style={{ fontWeight: 800, fontSize: 16, color: a }}>{s.price}</div></button>)}</div>)}
        </div>}

        {step === "staff" && <div className="fade-up">
          <Hdr title="Choose Stylist" onBack={() => setStep("services")} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, paddingTop: 20 }}>{salon.staff.map((s) => <button key={s.id} onClick={() => { setSelStaff(s); setStep("date"); }} style={{ padding: 20, borderRadius: 16, border: selStaff?.id === s.id ? "2px solid " + a : "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.04)", cursor: "pointer", textAlign: "center", color: "#fff", fontFamily: "inherit" }}><Av src={s.avatar} sz={56} bg={s.color + "22"} /><div style={{ fontWeight: 700, fontSize: 14, marginTop: 10 }}>{s.name}</div><div style={{ fontSize: 11, opacity: .4 }}>{s.role}</div></button>)}</div>
        </div>}

        {step === "date" && <div className="fade-up">
          <Hdr title="Pick Date" onBack={() => setStep("staff")} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, paddingTop: 20 }}>{dates.map((d) => { const ds = fd(d), day = DAYS[d.getDay()], hrs = salon.hours[day], closed = !hrs || hrs === "Closed" || salon.holidays?.includes(ds); return <button key={ds} disabled={closed} onClick={() => { setSelDate(d); setSelTime(null); setStep("time"); }} style={{ padding: "12px 8px", borderRadius: 12, border: selDate && fd(selDate) === ds ? "2px solid " + a : "1px solid rgba(255,255,255,0.08)", background: closed ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.04)", cursor: closed ? "not-allowed" : "pointer", textAlign: "center", color: closed ? "rgba(255,255,255,0.15)" : "#fff", fontFamily: "inherit" }}><div style={{ fontSize: 10, textTransform: "uppercase", opacity: .5 }}>{day}</div><div style={{ fontSize: 18, fontWeight: 700, margin: "4px 0" }}>{d.getDate()}</div><div style={{ fontSize: 10, opacity: .4 }}>{d.toLocaleDateString("en-GB", { month: "short" })}</div></button>; })}</div>
        </div>}

        {step === "time" && <div className="fade-up">
          <Hdr title="Select Time" onBack={() => setStep("date")} />
          {slots.length > 0 ? <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8, paddingTop: 20 }}>{slots.map((t) => <button key={t} onClick={() => { setSelTime(t); setStep("confirm"); }} style={{ padding: "14px 8px", borderRadius: 12, border: selTime === t ? "2px solid " + a : "1px solid rgba(255,255,255,0.08)", background: selTime === t ? a + "22" : "rgba(255,255,255,0.04)", cursor: "pointer", color: "#fff", fontFamily: "inherit", fontSize: 14, fontWeight: 600 }}>{ft(Math.floor(t / 60), t % 60)}</button>)}</div>
            : <div style={{ textAlign: "center", padding: "40px 0" }}>
              <div style={{ opacity: .3, fontSize: 14, marginBottom: 16 }}>No available slots</div>
              <div style={{ background: "rgba(240,173,78,0.08)", borderRadius: 14, padding: 20, border: "1px solid rgba(240,173,78,0.2)" }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: "#f0ad4e", marginBottom: 8 }}>Join Waitlist?</div>
                <div style={{ fontSize: 12, opacity: .5, marginBottom: 14, lineHeight: 1.5 }}>Get notified if a slot opens up.</div>
                <div style={{ display: "flex", gap: 6, justifyContent: "center", marginBottom: 14 }}>{["morning", "afternoon", "any"].map((p) => <Pill key={p} active={wlPref === p} color={a} onClick={() => setWlPref(p)}>{p[0].toUpperCase() + p.slice(1)}</Pill>)}</div>
                <Btn full color="#f0ad4e" onClick={joinWaitlist} style={{ borderRadius: 10, fontSize: 13 }}>Join Waitlist</Btn>
              </div>
            </div>}
        </div>}

        {step === "confirm" && <div className="fade-up">
          <Hdr title="Confirm Booking" onBack={() => setStep("time")} />
          <div style={{ paddingTop: 20 }}>
            <div style={{ background: "rgba(255,255,255,0.06)", borderRadius: 16, padding: 20 }}>
              {[{ l: "Service", v: selSvc?.name }, { l: "Stylist", v: selStaff?.name }, { l: "Date", v: selDate?.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }) }, { l: "Time", v: selTime != null ? ft(Math.floor(selTime / 60), selTime % 60) : "" }, { l: "Price", v: selSvc?.price }].map((r) => <div key={r.l} style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,0.06)" }}><span style={{ opacity: .5, fontSize: 13 }}>{r.l}</span><span style={{ fontWeight: 700, fontSize: 14 }}>{r.v}</span></div>)}
            </div>
            <Inp label="Your Name" value={cName} onChange={(e) => setCName(e.target.value)} style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#fff", marginTop: 20 }} />
            <Inp label="Phone (optional)" value={cPhone} onChange={(e) => setCPhone(e.target.value)} style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#fff" }} />
            <Btn full color={a} disabled={!cName} onClick={book} style={{ borderRadius: 14, marginTop: 8, fontSize: 16 }}>Confirm Booking</Btn>
          </div>
        </div>}

        {step === "ooh-request" && <div className="fade-up">
          <Hdr title="Out-of-Hours Request" onBack={() => setStep("home")} />
          <div style={{ paddingTop: 16 }}>
            <div style={{ marginBottom: 16 }}><label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.4)", marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>Service</label><select value={oohReq.svcId} onChange={(e) => setOohReq({ ...oohReq, svcId: e.target.value })} style={{ width: "100%", padding: "12px 14px", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, fontSize: 15, fontFamily: "inherit", background: "rgba(255,255,255,0.06)", color: "#fff", outline: "none" }}><option value="">Choose...</option>{salon.services.map((s) => <option key={s.id} value={s.id}>{s.name} - {s.price}</option>)}</select></div>
            <div style={{ display: "flex", gap: 12 }}><div style={{ flex: 1 }}><Inp label="Date" type="date" value={oohReq.date} onChange={(e) => setOohReq({ ...oohReq, date: e.target.value })} style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#fff" }} /></div><div style={{ flex: 1 }}><Inp label="Time" type="time" value={oohReq.time} onChange={(e) => setOohReq({ ...oohReq, time: e.target.value })} style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#fff" }} /></div></div>
            <div style={{ marginBottom: 16 }}><label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "rgba(255,255,255,0.4)", marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>Note (optional)</label><textarea value={oohReq.note} onChange={(e) => setOohReq({ ...oohReq, note: e.target.value })} rows={3} style={{ width: "100%", padding: "12px 14px", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, fontSize: 15, fontFamily: "inherit", background: "rgba(255,255,255,0.06)", color: "#fff", outline: "none", resize: "none", boxSizing: "border-box" }} /></div>
            <Btn full color={a} disabled={!oohReq.svcId || !oohReq.date || !oohReq.time} onClick={submitOoh} style={{ borderRadius: 14 }}>Send Request</Btn>
          </div>
        </div>}

        {step === "ooh-sent" && <div className="fade-up" style={{ textAlign: "center", padding: "60px 0" }}>
          <div style={{ width: 72, height: 72, borderRadius: "50%", background: "#f0ad4e22", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 20, margin: "0 auto 20px" }}><Ic n="clock" sz={32} /></div>
          <h2 style={{ margin: "0 0 8px", fontSize: 22 }}>Request Sent!</h2>
          <p style={{ opacity: .5, fontSize: 14, lineHeight: 1.6, margin: "0 0 24px", maxWidth: 300, marginLeft: "auto", marginRight: "auto" }}>{salon.name} will review and send a price quote.</p>
          <Btn color={a} onClick={() => setStep("home")} style={{ borderRadius: 14 }}>Back to Home</Btn>
        </div>}

      </div>
      {cancelId && <div style={{ position: "fixed", inset: 0, zIndex: 999, display: "flex", alignItems: "center", justifyContent: "center" }}><div onClick={() => setCancelId(null)} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.6)" }} /><div style={{ position: "relative", background: "#1e1e2e", borderRadius: 20, padding: 28, width: "min(90vw,360px)", textAlign: "center", color: "#fff" }}><h3 style={{ margin: "0 0 8px", fontSize: 18, fontWeight: 700 }}>Cancel?</h3><p style={{ opacity: .5, fontSize: 13, margin: "0 0 24px" }}>Slot will be freed.</p><div style={{ display: "flex", gap: 10 }}><Btn full variant="outline" color="rgba(255,255,255,0.3)" onClick={() => setCancelId(null)} style={{ borderRadius: 12, color: "#fff" }}>Keep</Btn><Btn full color="#e74c3c" onClick={() => cancelBk(cancelId)} style={{ borderRadius: 12 }}>Cancel</Btn></div></div></div>}
      {reviewBk && <Modal title="Leave a Review" onClose={() => setReviewBk(null)}><div style={{ textAlign: "center", marginBottom: 16 }}><div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>{salon.services.find((s) => s.id === reviewBk.serviceId)?.name} with {salon.staff.find((s) => s.id === reviewBk.staffId)?.name}</div><Stars rating={reviewRating} sz={32} onRate={setReviewRating} /></div><div style={{ marginBottom: 16 }}><textarea value={reviewText} onChange={(e) => setReviewText(e.target.value)} placeholder="Share your experience..." rows={4} style={{ width: "100%", padding: "12px 14px", border: "2px solid #eee", borderRadius: 12, fontSize: 15, fontFamily: "inherit", outline: "none", resize: "none", boxSizing: "border-box" }} /></div><Btn full color={a} disabled={!reviewRating} onClick={submitReview}>Submit Review</Btn></Modal>}
    </div>
  );
};

// ══════════════════════════════════════════════════
// ── STAFF DASHBOARD ──
// ══════════════════════════════════════════════════
const StaffDash = ({ salon, setSalon, staffId, onLogout }) => {
  const [tab, setTab] = useState("schedule");
  const [selDate, setSelDate] = useState(fd(new Date()));
  const [avEdit, setAvEdit] = useState(null);
  const staff = salon.staff.find((s) => s.id === staffId);
  const ac = salon.accent, todayS = fd(new Date());
  if (!staff) return <div style={{ padding: 40, textAlign: "center" }}>Staff not found</div>;

  const myBk = useMemo(() => (salon.bookings || []).filter((b) => b.staffId === staffId).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.startMin - b.startMin), [salon.bookings, staffId]);
  const dayBk = myBk.filter((b) => b.date === selDate);
  const upBk = myBk.filter((b) => b.date >= todayS);
  const myRevs = useMemo(() => (salon.reviews || []).filter((r) => r.staffId === staffId && !r.hidden), [salon.reviews, staffId]);
  const avgR = myRevs.length ? (myRevs.reduce((s, r) => s + r.rating, 0) / myRevs.length).toFixed(1) : null;
  const myRev = useMemo(() => { const bks = myBk.filter((b) => b.date < todayS); return bks.reduce((s, b) => s + (salon.services.find((sv) => sv.id === b.serviceId)?.price || 0), 0); }, [myBk, salon.services, todayS]);

  const NB = ({ icon, label, id: i }) => <button onClick={() => setTab(i)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", color: tab === i ? ac : "#999", fontFamily: "inherit", fontSize: 10, fontWeight: 600, padding: "8px 0" }}><Ic n={icon} sz={20} />{label}</button>;

  return (
    <div style={{ minHeight: "100vh", background: "#f7f7f8", fontFamily: "'DM Sans',sans-serif", paddingBottom: 80 }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700;800&family=Playfair+Display:wght@700&display=swap" rel="stylesheet" />
      <div style={{ background: "#fff", padding: "16px 20px", borderBottom: "1px solid #eee", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div><div style={{ fontSize: 18, fontWeight: 800, fontFamily: "'Playfair Display',serif" }}>{salon.name}</div><div style={{ fontSize: 12, opacity: .5 }}>Staff: {staff.name}</div></div>
        <button onClick={onLogout} style={{ background: "none", border: "1px solid #ddd", borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Logout</button>
      </div>
      <div style={{ padding: "0 20px" }}>
        {tab === "schedule" && <div style={{ paddingTop: 20 }}>
          <Inp label="Date" type="date" value={selDate} onChange={(e) => setSelDate(e.target.value)} />
          <div style={{ fontSize: 12, fontWeight: 700, opacity: .4, textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>Bookings ({dayBk.length})</div>
          {dayBk.length === 0 && <div style={{ textAlign: "center", opacity: .3, padding: 30, fontSize: 14 }}>No bookings</div>}
          {dayBk.map((b) => { const svc = salon.services.find((s) => s.id === b.serviceId); return <div key={b.id} style={{ background: "#fff", borderRadius: 14, padding: 16, marginBottom: 10, border: "1px solid #eee" }}><div style={{ display: "flex", justifyContent: "space-between" }}><div><div style={{ fontWeight: 700, fontSize: 15 }}>{svc?.name}</div><div style={{ fontSize: 13, color: "#777" }}>{b.clientName}</div></div><div style={{ fontWeight: 700, color: ac }}>{ft(Math.floor(b.startMin / 60), b.startMin % 60)}</div></div><CalBtns bk={b} /></div>; })}
        </div>}

        {tab === "availability" && <div style={{ paddingTop: 20 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>Manage Availability</h3>
          <Inp label="Select Date" type="date" value={avEdit || ""} onChange={(e) => setAvEdit(e.target.value)} />
          {avEdit && <div style={{ background: "#fff", borderRadius: 14, padding: 20, marginTop: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}><span style={{ fontWeight: 600 }}>{avEdit}</span>
              <button onClick={async () => { const av = { ...(staff.availability || {}), [avEdit]: { available: !(staff.availability?.[avEdit]?.available ?? true) } }; const u = { ...salon, staff: salon.staff.map((s) => s.id === staffId ? { ...s, availability: av } : s) }; await S.saveFullSalon(u); setSalon(u); }} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: staff.availability?.[avEdit]?.available === false ? "#2ec4b6" : "#e74c3c", color: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>{staff.availability?.[avEdit]?.available === false ? "Mark Available" : "Mark Unavailable"}</button>
            </div>
            {staff.availability?.[avEdit]?.available !== false && <Inp label="Custom Hours (e.g. 10:00-16:00)" value={staff.availability?.[avEdit]?.customHours || ""} onChange={async (e) => { const av = { ...(staff.availability || {}), [avEdit]: { available: true, customHours: e.target.value || null } }; const u = { ...salon, staff: salon.staff.map((s) => s.id === staffId ? { ...s, availability: av } : s) }; await S.saveFullSalon(u); setSalon(u); }} placeholder="Leave empty for normal hours" />}
          </div>}
        </div>}

        {tab === "stats" && <div style={{ paddingTop: 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div style={{ background: "#fff", borderRadius: 14, padding: 20, textAlign: "center" }}><div style={{ fontSize: 28, fontWeight: 800 }}>{upBk.length}</div><div style={{ fontSize: 11, opacity: .4, fontWeight: 600 }}>Upcoming</div></div>
            <div style={{ background: "#fff", borderRadius: 14, padding: 20, textAlign: "center" }}><div style={{ fontSize: 28, fontWeight: 800 }}>{myRev}</div><div style={{ fontSize: 11, opacity: .4, fontWeight: 600 }}>Revenue</div></div>
            <div style={{ background: "#fff", borderRadius: 14, padding: 20, textAlign: "center" }}><div style={{ fontSize: 28, fontWeight: 800 }}>{avgR || "-"}</div><div style={{ fontSize: 11, opacity: .4, fontWeight: 600 }}>Avg Rating</div>{avgR && <Stars rating={Math.round(Number(avgR))} sz={14} />}</div>
            <div style={{ background: "#fff", borderRadius: 14, padding: 20, textAlign: "center" }}><div style={{ fontSize: 28, fontWeight: 800 }}>{myRevs.length}</div><div style={{ fontSize: 11, opacity: .4, fontWeight: 600 }}>Reviews</div></div>
          </div>
          {myRevs.length > 0 && <div style={{ marginTop: 20 }}><div style={{ fontSize: 12, fontWeight: 700, opacity: .4, textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>Recent Reviews</div>
            {myRevs.slice(0, 5).map((r) => <div key={r.id} style={{ background: "#fff", borderRadius: 12, padding: 14, marginBottom: 8 }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><span style={{ fontWeight: 600, fontSize: 13 }}>{r.clientName}</span><Stars rating={r.rating} sz={12} /></div>{r.text && <div style={{ fontSize: 12, color: "#777", marginTop: 4 }}>{r.text}</div>}</div>)}
          </div>}
        </div>}
      </div>
      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "#fff", borderTop: "1px solid #eee", display: "flex", justifyContent: "space-around", padding: "8px 0 env(safe-area-inset-bottom,8px)", zIndex: 100 }}><NB icon="calendar" label="Schedule" id="schedule" /><NB icon="clock" label="Availability" id="availability" /><NB icon="chart" label="Stats" id="stats" /></div>
    </div>
  );
  // CalBtns needs to be available in this scope
  function CalBtns({ bk }) {
    return <div style={{ display: "flex", gap: 6, marginTop: 8 }}><button onClick={() => downloadICS(bk, salon)} style={{ background: "#f5f5f5", border: "none", borderRadius: 8, padding: "5px 10px", color: "#333", fontSize: 11, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4 }}><Ic n="calendar" sz={12} />iCal</button><a href={googleCalUrl(bk, salon)} target="_blank" rel="noopener" style={{ background: "#f5f5f5", borderRadius: 8, padding: "5px 10px", color: "#333", fontSize: 11, textDecoration: "none", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 4 }}><Ic n="calendar" sz={12} />Google</a></div>;
  }
};

// ══════════════════════════════════════════════════
// ── SUPER ADMIN DASHBOARD ──
// ══════════════════════════════════════════════════
const SuperAdminDash = ({ salons, onLogout }) => {
  const [tab, setTab] = useState("salons");
  const [viewSalon, setViewSalon] = useState(null);
  const allBk = useMemo(() => Object.values(salons).flatMap((s) => (s.bookings || []).map((b) => ({ ...b, salonName: s.name, salonId: s.id }))).sort((a, b) => (b.createdAt || b.date || "").localeCompare(a.createdAt || a.date || "")), [salons]);
  const totalRev = useMemo(() => Object.values(salons).reduce((t, s) => t + (s.bookings || []).reduce((r, b) => r + (s.services.find((sv) => sv.id === b.serviceId)?.price || 0), 0), 0), [salons]);
  const totalClients = useMemo(() => Object.values(salons).reduce((t, s) => t + (s.clients || []).length, 0), [salons]);

  const NB = ({ icon, label, id: i }) => <button onClick={() => setTab(i)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", color: tab === i ? "#e94560" : "#999", fontFamily: "inherit", fontSize: 10, fontWeight: 600, padding: "8px 0" }}><Ic n={icon} sz={20} />{label}</button>;

  return (
    <div style={{ minHeight: "100vh", background: "#f7f7f8", fontFamily: "'DM Sans',sans-serif", paddingBottom: 80 }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700;800&family=Playfair+Display:wght@700&display=swap" rel="stylesheet" />
      <div style={{ background: "linear-gradient(135deg,#1a1a2e,#16213e)", padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ color: "#fff" }}><div style={{ fontSize: 18, fontWeight: 800, fontFamily: "'Playfair Display',serif" }}>Super Admin</div><div style={{ fontSize: 11, opacity: .5 }}>Book.app Platform</div></div>
        <button onClick={onLogout} style={{ background: "rgba(255,255,255,0.1)", border: "none", borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", color: "#fff" }}>Logout</button>
      </div>
      <div style={{ padding: "0 20px" }}>
        {tab === "salons" && <div style={{ paddingTop: 20 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>All Salons ({Object.keys(salons).length})</h3>
          {Object.values(salons).map((s) => <div key={s.id} style={{ background: "#fff", borderRadius: 14, padding: 16, marginBottom: 10, border: "1px solid #eee", cursor: "pointer" }} onClick={() => setViewSalon(viewSalon === s.id ? null : s.id)}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div style={{ display: "flex", alignItems: "center", gap: 12 }}><div style={{ fontSize: 28 }}>{s.logo}</div><div><div style={{ fontWeight: 700, fontSize: 15 }}>{s.name}</div><div style={{ fontSize: 12, color: "#777" }}>{s.email}</div></div></div><div style={{ textAlign: "right", fontSize: 12, color: "#999" }}><div>{(s.bookings || []).length} bookings</div><div>{(s.staff || []).length} staff</div></div></div>
            {viewSalon === s.id && <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #eee", fontSize: 13 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}><div><strong>Clients:</strong> {(s.clients || []).length}</div><div><strong>Services:</strong> {(s.services || []).length}</div><div><strong>Reviews:</strong> {(s.reviews || []).length}</div><div><strong>Waitlist:</strong> {(s.waitlist || []).filter((w) => w.status === "waiting").length}</div></div>
            </div>}
          </div>)}
        </div>}

        {tab === "activity" && <div style={{ paddingTop: 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
            <div style={{ background: "#fff", borderRadius: 14, padding: 20, textAlign: "center" }}><div style={{ fontSize: 28, fontWeight: 800 }}>{Object.keys(salons).length}</div><div style={{ fontSize: 11, opacity: .4, fontWeight: 600 }}>Salons</div></div>
            <div style={{ background: "#fff", borderRadius: 14, padding: 20, textAlign: "center" }}><div style={{ fontSize: 28, fontWeight: 800 }}>{allBk.length}</div><div style={{ fontSize: 11, opacity: .4, fontWeight: 600 }}>Bookings</div></div>
            <div style={{ background: "#fff", borderRadius: 14, padding: 20, textAlign: "center" }}><div style={{ fontSize: 28, fontWeight: 800 }}>{totalClients}</div><div style={{ fontSize: 11, opacity: .4, fontWeight: 600 }}>Clients</div></div>
            <div style={{ background: "#fff", borderRadius: 14, padding: 20, textAlign: "center" }}><div style={{ fontSize: 28, fontWeight: 800 }}>{totalRev}</div><div style={{ fontSize: 11, opacity: .4, fontWeight: 600 }}>Revenue</div></div>
          </div>
          <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Recent Bookings</h3>
          {allBk.slice(0, 20).map((b) => <div key={b.id} style={{ background: "#fff", borderRadius: 12, padding: 12, marginBottom: 6, fontSize: 13, display: "flex", justifyContent: "space-between" }}><div><span style={{ fontWeight: 600 }}>{b.clientName}</span> <span style={{ opacity: .4 }}>at</span> <span style={{ fontWeight: 600 }}>{b.salonName}</span></div><span style={{ color: "#999" }}>{b.date}</span></div>)}
        </div>}
      </div>
      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "#fff", borderTop: "1px solid #eee", display: "flex", justifyContent: "space-around", padding: "8px 0 env(safe-area-inset-bottom,8px)", zIndex: 100 }}><NB icon="grid" label="Salons" id="salons" /><NB icon="chart" label="Activity" id="activity" /></div>
    </div>
  );
};

// ══════════════════════════════════════════════════
// ── OWNER DASHBOARD ──
// ══════════════════════════════════════════════════
const OwnerDash = ({ salon, setSalon, onLogout }) => {
  const [tab, setTab] = useState("overview"); const [showAddStaff, setShowAddStaff] = useState(false); const [showAddSvc, setShowAddSvc] = useState(false); const [showAddHol, setShowAddHol] = useState(false); const [showAddBk, setShowAddBk] = useState(false);
  const [nStaff, setNStaff] = useState({ name: "", role: "", avatar: "\uD83E\uDDD1", color: "#6366f1" }); const [editStaff, setEditStaff] = useState(null); const [nSvc, setNSvc] = useState({ name: "", duration: 30, price: 0, category: "" }); const [editSvc, setEditSvc] = useState(null); const [showImportSvc, setShowImportSvc] = useState(false); const [importSvcPv, setImportSvcPv] = useState(null); const [importSvcDone, setImportSvcDone] = useState(0); const [nHol, setNHol] = useState(""); const [nBk, setNBk] = useState({ cn: "", ce: "", svcId: "", stId: "", date: "", time: "" });
  const [bMsg, setBMsg] = useState(""); const [bType, setBType] = useState("push"); const [drill, setDrill] = useState(null); const [dRange, setDRange] = useState("7"); const [dFrom, setDFrom] = useState(""); const [dTo, setDTo] = useState(""); const [cSearch, setCSearch] = useState(""); const [cFilter, setCFilter] = useState("all"); const [msgTab, setMsgTab] = useState("send"); const [bkCS, setBkCS] = useState("");
  const [calM, setCalM] = useState(() => ({ y: new Date().getFullYear(), m: new Date().getMonth() })); const [calD, setCalD] = useState(fd(new Date())); const [calStaff, setCalStaff] = useState("all"); const [confirm, setConfirm] = useState(null);
  const [moreTab, setMoreTab] = useState(null); const [reviewResp, setReviewResp] = useState({}); const [staffLoginModal, setStaffLoginModal] = useState(null); const [staffLoginEmail, setStaffLoginEmail] = useState(""); const [staffLoginPw, setStaffLoginPw] = useState("");
  const [exportRange, setExportRange] = useState({ from: "", to: "" });
  const ac = salon.accent, sv = async (u) => { await S.saveFullSalon(u); setSalon(u); }, todayS = fd(new Date());
  const allBk = (salon.bookings || []).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.startMin - b.startMin); const nowMin = new Date().getHours() * 60 + new Date().getMinutes(); const todayBk = allBk.filter((b) => b.date === todayS); const upBk = allBk.filter((b) => b.date > todayS || (b.date === todayS && b.startMin + 60 > nowMin));
  const yestS = useMemo(() => { const y = new Date(); y.setDate(y.getDate() - 1); return fd(y); }, []);
  const pastCut = useMemo(() => { if (dRange === "all") return "2000-01-01"; if (dRange === "custom" && dFrom) return dFrom; if (dRange === "today") return todayS; if (dRange === "yesterday") return yestS; if (isNaN(Number(dRange))) return todayS; const d = new Date(); d.setDate(d.getDate() - Number(dRange)); return fd(d); }, [dRange, dFrom, todayS, yestS]);
  const pastBk = allBk.filter((b) => { if (dRange === "today") return b.date === todayS; if (dRange === "yesterday") return b.date === yestS; if (dRange === "custom") return b.date >= pastCut && (!dTo || b.date <= dTo); return b.date < todayS && b.date >= pastCut; }); const filtAll = allBk.filter((b) => b.date >= pastCut);
  const rev = (bks) => bks.reduce((s, b) => s + (salon.services.find((v) => v.id === b.serviceId)?.price || 0), 0);
  const campaigns = salon.campaigns || []; const msgLog = salon.messageLog || [];
  const staffSt = useMemo(() => { const st = {}; salon.staff.forEach((s) => { st[s.id] = { ...s, bks: 0, rv: 0 }; }); filtAll.forEach((b) => { if (st[b.staffId]) { st[b.staffId].bks++; st[b.staffId].rv += (salon.services.find((s) => s.id === b.serviceId)?.price || 0); } }); return Object.values(st).sort((a, b) => b.rv - a.rv); }, [salon, filtAll]);
  const clAn = useMemo(() => { const now = new Date(), ya = new Date(now); ya.setFullYear(ya.getFullYear() - 1); const yas = fd(ya); return (salon.clients || []).map((c) => { const cb = allBk.filter((b) => b.date >= yas && ((c.email && b.clientEmail === c.email) || (c.phone && b.clientPhone === c.phone))).sort((a, b) => a.date.localeCompare(b.date)); const lb = cb.length > 0 ? cb[cb.length - 1] : null, lvd = lb?.date || c.lastVisit || null; const ds = lvd ? Math.floor((now - new Date(lvd + "T00:00:00")) / 86400000) : null; let avg = null; if (cb.length >= 2) { const g = []; for (let i = 1; i < cb.length; i++) g.push(Math.floor((new Date(cb[i].date + "T00:00:00") - new Date(cb[i - 1].date + "T00:00:00")) / 86400000)); avg = Math.round(g.reduce((s, x) => s + x, 0) / g.length); } let st = "new"; if (!cb.length && !c.lastVisit) st = "new"; else if (avg && ds > avg * 2) st = "overdue"; else if (avg && ds > avg * 1.3) st = "at-risk"; else if (cb.length >= 2) st = "regular"; else st = ds > 60 ? "overdue" : ds > 35 ? "at-risk" : "regular"; return { ...c, lvd, ds, avg, st, bk12: cb.length, hu: allBk.some((b) => b.date >= todayS && ((c.email && b.clientEmail === c.email) || (c.phone && b.clientPhone === c.phone))) }; }); }, [salon, allBk, todayS]);

  const cancelBk = async (id) => {
    const cancelled = salon.bookings.find((b) => b.id === id);
    const u = { ...salon, bookings: salon.bookings.filter((b) => b.id !== id) };
    await sv(u); setConfirm(null);
    if (cancelled && salon.notificationSettings?.cancellationNotify !== false) {
      const svc = salon.services.find((s) => s.id === cancelled.serviceId);
      await queueNotification(u, setSalon, { type: "cancellation", channel: "email", recipient_email: cancelled.clientEmail, recipient_name: cancelled.clientName, subject: renderTemplate(DEFAULT_TEMPLATES.cancellation.subject, { salonName: salon.name }), body: renderTemplate(DEFAULT_TEMPLATES.cancellation.body, { clientName: cancelled.clientName, serviceName: svc?.name || "", date: cancelled.date, time: ft(Math.floor(cancelled.startMin / 60), cancelled.startMin % 60), salonName: salon.name }), booking_id: id });
    }
    if (cancelled) await checkWaitlist(u, setSalon, cancelled);
  };
  const noShow = async (id) => { const bk = salon.bookings.find((b) => b.id === id); if (!bk) return; const ub = salon.bookings.map((b) => b.id === id ? { ...b, status: "no-show" } : b); const uc = (salon.clients || []).map((c) => ((bk.clientEmail && c.email === bk.clientEmail) || (bk.clientPhone && c.phone === bk.clientPhone)) ? { ...c, noShows: (c.noShows || 0) + 1 } : c); await sv({ ...salon, bookings: ub, clients: uc }); setConfirm(null); };
  const addBk = async () => {
    const nb = nBk; if (!nb.cn || !nb.svcId || !nb.stId || !nb.date || !nb.time) return;
    const [h, m] = nb.time.split(":").map(Number); const svc = salon.services.find((s) => s.id === nb.svcId);
    const bk = { id: uid(), serviceId: nb.svcId, staffId: nb.stId, date: nb.date, startMin: h * 60 + m, duration: svc?.duration || 30, clientName: sanitize(nb.cn), clientEmail: nb.ce?.toLowerCase() || "", createdAt: new Date().toISOString(), addedBy: "owner" };
    const u = { ...salon, bookings: [...(salon.bookings || []), bk] };
    await sv(u); setShowAddBk(false); setNBk({ cn: "", ce: "", svcId: "", stId: "", date: "", time: "" });
    if (salon.notificationSettings?.confirmations !== false && nb.ce) {
      const tpl = DEFAULT_TEMPLATES.confirmation;
      await queueNotification(u, setSalon, { type: "confirmation", channel: "email", recipient_email: nb.ce.toLowerCase(), recipient_name: nb.cn, subject: renderTemplate(tpl.subject, { salonName: salon.name }), body: renderTemplate(tpl.body, { clientName: nb.cn, serviceName: svc?.name || "", staffName: salon.staff.find((s) => s.id === nb.stId)?.name || "", date: nb.date, time: nb.time, salonName: salon.name }), booking_id: bk.id });
    }
  };
  const sendBcast = async () => { await sv({ ...salon, messageLog: [...msgLog, { id: uid(), channel: bType, message: sanitize(bMsg), sentAt: new Date().toISOString(), recipients: salon.clients?.length || 0 }] }); setBMsg(""); };
  const addCamp = async (c) => { await sv({ ...salon, campaigns: [...campaigns, { id: uid(), ...c, active: true }] }); };
  const stC = { "overdue": "#e74c3c", "at-risk": "#f0ad4e", "regular": "#2ec4b6", "new": "#6366f1" }; const stL = { "overdue": "Overdue", "at-risk": "At Risk", "regular": "Regular", "new": "New" };

  // Export functions
  const exportBookings = () => {
    const bks = allBk.filter((b) => (!exportRange.from || b.date >= exportRange.from) && (!exportRange.to || b.date <= exportRange.to));
    const csv = toCSV(bks, [
      { label: "Date", key: "date" }, { label: "Time", getter: (b) => ft(Math.floor(b.startMin / 60), b.startMin % 60) },
      { label: "Client", key: "clientName" }, { label: "Email", key: "clientEmail" }, { label: "Phone", key: "clientPhone" },
      { label: "Service", getter: (b) => salon.services.find((s) => s.id === b.serviceId)?.name || "" },
      { label: "Staff", getter: (b) => salon.staff.find((s) => s.id === b.staffId)?.name || "" },
      { label: "Duration", getter: (b) => b.duration + "min" },
      { label: "Price", getter: (b) => salon.services.find((s) => s.id === b.serviceId)?.price || 0 },
      { label: "Status", getter: (b) => b.status || "confirmed" },
    ]);
    downloadFile(csv, `bookings-${salon.id}-${fd(new Date())}.csv`);
  };
  const exportClients = () => {
    const csv = toCSV(clAn, [
      { label: "Name", key: "name" }, { label: "Email", key: "email" }, { label: "Phone", key: "phone" },
      { label: "Visits (12m)", key: "bk12" }, { label: "Last Visit", key: "lvd" },
      { label: "No Shows", key: "noShows" }, { label: "Status", key: "st" },
      { label: "Avg Interval (days)", key: "avg" },
    ]);
    downloadFile(csv, `clients-${salon.id}-${fd(new Date())}.csv`);
  };
  const exportRevenue = () => {
    const bks = allBk.filter((b) => (!exportRange.from || b.date >= exportRange.from) && (!exportRange.to || b.date <= exportRange.to));
    const csv = toCSV(bks, [
      { label: "Date", key: "date" }, { label: "Service", getter: (b) => salon.services.find((s) => s.id === b.serviceId)?.name || "" },
      { label: "Staff", getter: (b) => salon.staff.find((s) => s.id === b.staffId)?.name || "" },
      { label: "Client", key: "clientName" },
      { label: "Price", getter: (b) => salon.services.find((s) => s.id === b.serviceId)?.price || 0 },
      { label: "Surcharge", getter: (b) => b.surcharge || 0 },
      { label: "Total", getter: (b) => (salon.services.find((s) => s.id === b.serviceId)?.price || 0) + (b.surcharge || 0) },
    ]);
    downloadFile(csv, `revenue-${salon.id}-${fd(new Date())}.csv`);
  };
  const exportJSON = () => {
    downloadFile(JSON.stringify(salon, null, 2), `${salon.id}-backup-${fd(new Date())}.json`, "application/json");
  };

  const createStaffLogin = async () => {
    if (!staffLoginModal || !staffLoginEmail || !staffLoginPw || staffLoginPw.length < 6) return;
    await S.setAccount("st:" + salon.id + ":" + staffLoginModal, { email: staffLoginEmail.toLowerCase(), password: staffLoginPw, staffId: staffLoginModal, salonId: salon.id });
    const u = { ...salon, staff: salon.staff.map((s) => s.id === staffLoginModal ? { ...s, email: staffLoginEmail.toLowerCase() } : s) };
    await sv(u); setStaffLoginModal(null); setStaffLoginEmail(""); setStaffLoginPw("");
  };

  const NB = ({ icon, label, id: i, badge }) => <button onClick={() => { setTab(i); if (i !== "more") setMoreTab(null); }} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", color: tab === i ? ac : "#999", fontFamily: "inherit", fontSize: 10, fontWeight: 600, padding: "8px 0", position: "relative" }}><Ic n={icon} sz={20} />{label}{badge > 0 && <span style={{ position: "absolute", top: 2, right: -4, background: "#e74c3c", color: "#fff", fontSize: 9, fontWeight: 800, padding: "1px 5px", borderRadius: 10 }}>{badge}</span>}</button>;

  return (
    <div style={{ minHeight: "100vh", background: "#f7f7f8", fontFamily: "'DM Sans',sans-serif", paddingBottom: 80 }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700;800&family=Playfair+Display:wght@700&display=swap" rel="stylesheet" />
      <style>{"@keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}.fade-up{animation:fadeUp .4s ease forwards}::-webkit-scrollbar{display:none}"}</style>
      <div style={{ background: "#fff", padding: "16px 20px", borderBottom: "1px solid #eee", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div><div style={{ fontSize: 18, fontWeight: 800, fontFamily: "'Playfair Display',serif" }}>{salon.name}</div><div style={{ fontSize: 12, color: "#999" }}>{salon.tagline}</div></div>
        <button onClick={onLogout} style={{ background: "none", border: "1px solid #ddd", borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Logout</button>
      </div>
      <div style={{ padding: "0 20px" }}>

        {/* ── OVERVIEW TAB ── */}
        {tab === "overview" && <div className="fade-up" style={{ paddingTop: 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {[{ l: "Today", v: todayBk.length, d: "today" }, { l: "Upcoming", v: upBk.length, d: "upcoming" }, { l: "Revenue", v: rev(filtAll), d: "revenue" }, { l: "Clients", v: salon.clients?.length || 0, d: "clients" }].map((k) => <button key={k.l} onClick={() => setDrill(drill === k.d ? null : k.d)} style={{ background: "#fff", borderRadius: 16, padding: 20, border: drill === k.d ? "2px solid " + ac : "1px solid #eee", textAlign: "center", cursor: "pointer", fontFamily: "inherit" }}><div style={{ fontSize: 28, fontWeight: 800 }}>{k.v}</div><div style={{ fontSize: 11, color: "#999", fontWeight: 600, textTransform: "uppercase", letterSpacing: 1 }}>{k.l}</div></button>)}
          </div>
          {/* Calendar */}
          <div style={{ marginTop: 20, background: "#fff", borderRadius: 16, padding: 16, border: "1px solid #eee" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <button onClick={() => setCalM((p) => { let nm = p.m - 1, ny = p.y; if (nm < 0) { nm = 11; ny--; } return { y: ny, m: nm }; })} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18 }}>‹</button>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{new Date(calM.y, calM.m).toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</div>
              <button onClick={() => setCalM((p) => { let nm = p.m + 1, ny = p.y; if (nm > 11) { nm = 0; ny++; } return { y: ny, m: nm }; })} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18 }}>›</button>
            </div>
            <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}><Pill active={calStaff === "all"} onClick={() => setCalStaff("all")} color={ac}>All</Pill>{salon.staff.map((s) => <Pill key={s.id} active={calStaff === s.id} onClick={() => setCalStaff(s.id)} color={s.color}>{s.name}</Pill>)}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2, fontSize: 11 }}>
              {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <div key={i} style={{ textAlign: "center", fontWeight: 700, opacity: .3, padding: 4 }}>{d}</div>)}
              {(() => { const fd2 = new Date(calM.y, calM.m, 1), ld = new Date(calM.y, calM.m + 1, 0), cells = []; for (let i = 0; i < fd2.getDay(); i++) cells.push(<div key={"e" + i} />); for (let d = 1; d <= ld.getDate(); d++) { const ds = `${calM.y}-${String(calM.m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`; const ct = allBk.filter((b) => b.date === ds && (calStaff === "all" || b.staffId === calStaff)).length; cells.push(<button key={d} onClick={() => setCalD(ds)} style={{ textAlign: "center", padding: "6px 2px", borderRadius: 8, border: "none", background: calD === ds ? ac : ct > 0 ? ac + "15" : "transparent", color: calD === ds ? "#fff" : "#333", fontWeight: ct > 0 ? 700 : 400, cursor: "pointer", fontSize: 12, fontFamily: "inherit", position: "relative" }}>{d}{ct > 0 && <div style={{ width: 4, height: 4, borderRadius: 2, background: calD === ds ? "#fff" : ac, margin: "2px auto 0" }} />}</button>); } return cells; })()}
            </div>
          </div>
          {/* Upcoming bookings */}
          <div style={{ marginTop: 20 }}><div style={{ fontSize: 12, fontWeight: 700, opacity: .4, textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>Upcoming</div>
            {upBk.slice(0, 5).map((b) => { const svc = salon.services.find((s) => s.id === b.serviceId); const stf = salon.staff.find((s) => s.id === b.staffId); return <div key={b.id} style={{ background: "#fff", borderRadius: 14, padding: 14, marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center", border: "1px solid #eee" }}><div style={{ display: "flex", alignItems: "center", gap: 12 }}><div style={{ width: 4, height: 36, borderRadius: 2, background: stf?.color || ac }} /><div><div style={{ fontWeight: 700, fontSize: 14 }}>{svc?.name}</div><div style={{ fontSize: 12, color: "#777" }}>{b.clientName} - {stf?.name}</div></div></div><div style={{ textAlign: "right" }}><div style={{ fontWeight: 700, fontSize: 13 }}>{ft(Math.floor(b.startMin / 60), b.startMin % 60)}</div><div style={{ fontSize: 11, color: "#999" }}>{b.date}</div></div></div>; })}
          </div>
        </div>}

        {/* ── STAFF TAB ── */}
        {tab === "staff" && <div className="fade-up" style={{ paddingTop: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}><h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Staff</h3><Btn color={ac} onClick={() => setShowAddStaff(true)} style={{ padding: "8px 16px", fontSize: 12, borderRadius: 10 }}>+ Add</Btn></div>
          {salon.staff.map((s) => { const ss = staffSt.find((x) => x.id === s.id); const staffRevs = (salon.reviews || []).filter((r) => r.staffId === s.id && !r.hidden); const sAvgR = staffRevs.length ? (staffRevs.reduce((t, r) => t + r.rating, 0) / staffRevs.length).toFixed(1) : null; return <div key={s.id} style={{ background: "#fff", borderRadius: 16, padding: 16, marginBottom: 10, border: "1px solid #eee" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}><Av src={s.avatar} sz={48} bg={s.color + "22"} /><div style={{ flex: 1 }}><div style={{ fontWeight: 700, fontSize: 15 }}>{s.name}</div><div style={{ fontSize: 12, color: "#777" }}>{s.role}</div>{sAvgR && <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}><Stars rating={Math.round(Number(sAvgR))} sz={10} /><span style={{ fontSize: 11, color: "#999" }}>{sAvgR}</span></div>}</div><div style={{ textAlign: "right", fontSize: 12, color: "#999" }}><div>{ss?.bks || 0} bookings</div><div style={{ fontWeight: 600 }}>{ss?.rv || 0} rev</div></div></div>
            <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
              <button onClick={() => setEditStaff({ ...s })} style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #eee", background: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>Edit</button>
              <button onClick={() => { setStaffLoginModal(s.id); setStaffLoginEmail(s.email || ""); setStaffLoginPw(""); }} style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #eee", background: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", color: s.email ? "#2ec4b6" : "#6366f1" }}>{s.email ? "Login Created" : "Create Login"}</button>
              <button onClick={async () => { if (window.confirm("Delete " + s.name + "?")) await sv({ ...salon, staff: salon.staff.filter((x) => x.id !== s.id) }); }} style={{ padding: "6px 12px", borderRadius: 8, border: "none", background: "#e74c3c12", fontSize: 11, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", color: "#e74c3c" }}>Delete</button>
            </div>
          </div>; })}
        </div>}

        {/* ── CLIENTS TAB (with Reviews) ── */}
        {tab === "clients" && <div className="fade-up" style={{ paddingTop: 20 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}><Pill active={cFilter !== "reviews"} onClick={() => setCFilter("all")} color={ac}>Clients</Pill><Pill active={cFilter === "reviews"} onClick={() => setCFilter("reviews")} color={ac}>Reviews</Pill></div>

          {cFilter !== "reviews" ? <>
            <Inp placeholder="Search clients..." value={cSearch} onChange={(e) => setCSearch(e.target.value)} style={{ marginBottom: 8 }} />
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>{["all", "overdue", "at-risk", "regular", "new"].map((f) => <Pill key={f} active={cFilter === f} onClick={() => setCFilter(f)} color={stC[f]}>{stL[f] || "All"}</Pill>)}</div>
            {clAn.filter((c) => (cFilter === "all" || c.st === cFilter) && (!cSearch || c.name?.toLowerCase().includes(cSearch.toLowerCase()) || c.email?.toLowerCase().includes(cSearch.toLowerCase()))).map((c) => <div key={c.id} style={{ background: "#fff", borderRadius: 14, padding: 14, marginBottom: 8, border: "1px solid #eee" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div><div style={{ fontWeight: 700, fontSize: 14 }}>{c.name}</div><div style={{ fontSize: 12, color: "#777" }}>{c.email}</div></div><div style={{ display: "flex", alignItems: "center", gap: 8 }}>{c.hu && <span style={{ fontSize: 10, background: ac + "15", color: ac, padding: "2px 8px", borderRadius: 10, fontWeight: 700 }}>Upcoming</span>}<span style={{ fontSize: 10, fontWeight: 700, padding: "3px 10px", borderRadius: 10, background: stC[c.st] + "15", color: stC[c.st] }}>{stL[c.st]}</span></div></div>
              <div style={{ display: "flex", gap: 16, marginTop: 8, fontSize: 11, color: "#999" }}><span>{c.bk12} visits</span>{c.ds != null && <span>{c.ds}d ago</span>}{c.avg && <span>avg {c.avg}d</span>}{c.noShows > 0 && <span style={{ color: "#e74c3c" }}>{c.noShows} no-shows</span>}</div>
            </div>)}
          </> : <>
            {/* Reviews moderation */}
            <div style={{ fontSize: 12, fontWeight: 700, opacity: .4, textTransform: "uppercase", letterSpacing: 1, marginBottom: 12 }}>Reviews ({(salon.reviews || []).length})</div>
            {(salon.reviews || []).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).map((r) => {
              const staff = salon.staff.find((s) => s.id === r.staffId);
              const svc = salon.services.find((s) => s.id === r.serviceId);
              return <div key={r.id} style={{ background: "#fff", borderRadius: 14, padding: 16, marginBottom: 10, border: "1px solid #eee", opacity: r.hidden ? .5 : 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}><div><div style={{ fontWeight: 700, fontSize: 14 }}>{r.clientName}</div><div style={{ fontSize: 11, color: "#777" }}>{svc?.name} with {staff?.name}</div></div><Stars rating={r.rating} sz={14} /></div>
                {r.text && <div style={{ fontSize: 13, color: "#555", marginBottom: 8, lineHeight: 1.5 }}>{r.text}</div>}
                {r.ownerResponse && <div style={{ background: "#f5f5f5", borderRadius: 10, padding: 10, marginBottom: 8 }}><div style={{ fontSize: 10, fontWeight: 700, opacity: .4, textTransform: "uppercase", marginBottom: 4 }}>Your Response</div><div style={{ fontSize: 12, color: "#555" }}>{r.ownerResponse}</div></div>}
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  {!r.ownerResponse && <><input placeholder="Write a response..." value={reviewResp[r.id] || ""} onChange={(e) => setReviewResp({ ...reviewResp, [r.id]: e.target.value })} style={{ flex: 1, padding: "8px 12px", border: "1px solid #eee", borderRadius: 8, fontSize: 12, fontFamily: "inherit", outline: "none" }} /><button onClick={async () => { if (!reviewResp[r.id]) return; await sv({ ...salon, reviews: (salon.reviews || []).map((rv) => rv.id === r.id ? { ...rv, ownerResponse: sanitize(reviewResp[r.id]), ownerRespondedAt: new Date().toISOString() } : rv) }); setReviewResp({ ...reviewResp, [r.id]: "" }); }} style={{ padding: "8px 14px", borderRadius: 8, border: "none", background: ac, color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Reply</button></>}
                  <button onClick={async () => { await sv({ ...salon, reviews: (salon.reviews || []).map((rv) => rv.id === r.id ? { ...rv, hidden: !rv.hidden } : rv) }); }} style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #eee", background: "#fff", fontSize: 11, cursor: "pointer", fontFamily: "inherit", color: r.hidden ? "#2ec4b6" : "#e74c3c" }}>{r.hidden ? "Show" : "Hide"}</button>
                </div>
              </div>;
            })}
          </>}
        </div>}

        {/* ── MORE TAB ── */}
        {tab === "more" && <div className="fade-up" style={{ paddingTop: 20 }}>
          {!moreTab && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {[{ id: "services", icon: "scissors", label: "Services", desc: salon.services.length + " services" },
            { id: "messages", icon: "send", label: "Messages", desc: msgLog.length + " sent" },
            { id: "brand", icon: "star", label: "Brand", desc: "Settings" },
            { id: "schedule", icon: "clock", label: "Schedule", desc: "Hours & holidays" },
            { id: "export", icon: "download", label: "Export", desc: "CSV & Backup" },
            { id: "notifications", icon: "bell", label: "Notifications", desc: (salon.notifications || []).length + " sent" },
            { id: "waitlist", icon: "list", label: "Waitlist", desc: (salon.waitlist || []).filter((w) => w.status === "waiting").length + " waiting" },
            ].map((item) => <button key={item.id} onClick={() => setMoreTab(item.id)} style={{ background: "#fff", borderRadius: 16, padding: 20, border: "1px solid #eee", cursor: "pointer", textAlign: "center", fontFamily: "inherit" }}><Ic n={item.icon} sz={24} /><div style={{ fontWeight: 700, fontSize: 14, marginTop: 8 }}>{item.label}</div><div style={{ fontSize: 11, color: "#999", marginTop: 2 }}>{item.desc}</div></button>)}
          </div>}

          {moreTab && <div>
            <button onClick={() => setMoreTab(null)} style={{ display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 600, color: "#777", marginBottom: 16 }}><Ic n="back" sz={16} />Back</button>

            {/* ── Services ── */}
            {moreTab === "services" && <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}><h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Services</h3><div style={{ display: "flex", gap: 8 }}><Btn color={ac} onClick={() => setShowAddSvc(true)} style={{ padding: "8px 16px", fontSize: 12, borderRadius: 10 }}>+ Add</Btn><Btn variant="outline" color={ac} onClick={() => setShowImportSvc(true)} style={{ padding: "8px 16px", fontSize: 12, borderRadius: 10 }}>Import</Btn></div></div>
              {Object.entries((() => { const c = {}; salon.services.forEach((s) => { (c[s.category] = c[s.category] || []).push(s); }); return c; })()).map(([cat, svcs]) => <div key={cat}><div style={{ fontSize: 11, fontWeight: 700, opacity: .3, textTransform: "uppercase", letterSpacing: 1, margin: "16px 0 8px" }}>{cat}</div>{svcs.map((s) => <div key={s.id} style={{ background: "#fff", borderRadius: 12, padding: 14, marginBottom: 6, display: "flex", justifyContent: "space-between", alignItems: "center", border: "1px solid #eee" }}><div><div style={{ fontWeight: 700, fontSize: 14 }}>{s.name}</div><div style={{ fontSize: 12, color: "#777" }}>{s.duration}min</div></div><div style={{ display: "flex", alignItems: "center", gap: 10 }}><span style={{ fontWeight: 800, color: ac }}>{s.price}</span><button onClick={() => setEditSvc({ ...s })} style={{ background: "none", border: "1px solid #eee", borderRadius: 8, padding: "4px 10px", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}>Edit</button><button onClick={async () => await sv({ ...salon, services: salon.services.filter((x) => x.id !== s.id) })} style={{ background: "none", border: "none", color: "#e74c3c", cursor: "pointer", padding: 4 }}><Ic n="trash" sz={14} /></button></div></div>)}</div>)}
            </div>}

            {/* ── Schedule ── */}
            {moreTab === "schedule" && <div>
              <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>Business Hours</h3>
              {DAYS.map((d) => <div key={d} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid #eee" }}><span style={{ fontWeight: 600, fontSize: 14, textTransform: "capitalize" }}>{d}</span><input value={salon.hours[d] || "Closed"} onChange={async (e) => await sv({ ...salon, hours: { ...salon.hours, [d]: e.target.value } })} style={{ border: "1px solid #eee", borderRadius: 8, padding: "6px 12px", fontSize: 13, fontFamily: "inherit", width: 140, textAlign: "center" }} /></div>)}
              <h4 style={{ fontSize: 14, fontWeight: 700, marginTop: 24, marginBottom: 12 }}>Holidays</h4>
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}><input type="date" value={nHol} onChange={(e) => setNHol(e.target.value)} style={{ flex: 1, padding: "8px 12px", border: "1px solid #eee", borderRadius: 8, fontSize: 13, fontFamily: "inherit" }} /><Btn color={ac} disabled={!nHol} onClick={async () => { await sv({ ...salon, holidays: [...(salon.holidays || []), nHol] }); setNHol(""); }} style={{ padding: "8px 16px", fontSize: 12, borderRadius: 8 }}>Add</Btn></div>
              {(salon.holidays || []).map((h) => <div key={h} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", fontSize: 13 }}><span>{h}</span><button onClick={async () => await sv({ ...salon, holidays: salon.holidays.filter((x) => x !== h) })} style={{ background: "none", border: "none", color: "#e74c3c", cursor: "pointer" }}><Ic n="x" sz={14} /></button></div>)}
            </div>}

            {/* ── Messages ── */}
            {moreTab === "messages" && <div>
              <div style={{ display: "flex", gap: 8, marginBottom: 16 }}><Pill active={msgTab === "send"} onClick={() => setMsgTab("send")} color={ac}>Send</Pill><Pill active={msgTab === "auto"} onClick={() => setMsgTab("auto")} color={ac}>Auto</Pill></div>
              {msgTab === "send" && <div>
                <div style={{ marginBottom: 16 }}><textarea value={bMsg} onChange={(e) => setBMsg(e.target.value)} placeholder="Write a message to all clients..." rows={4} style={{ width: "100%", padding: "12px 14px", border: "2px solid #eee", borderRadius: 12, fontSize: 15, fontFamily: "inherit", resize: "none", outline: "none", boxSizing: "border-box" }} /></div>
                <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>{["push", "email", "sms"].map((t) => <Pill key={t} active={bType === t} onClick={() => setBType(t)} color={ac}>{t.toUpperCase()}</Pill>)}</div>
                <Btn full color={ac} disabled={!bMsg.trim()} onClick={sendBcast} style={{ borderRadius: 12 }}>Send to {salon.clients?.length || 0} clients</Btn>
                {msgLog.length > 0 && <div style={{ marginTop: 20 }}><div style={{ fontSize: 12, fontWeight: 700, opacity: .3, marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>Sent</div>{msgLog.slice(-5).reverse().map((m) => <div key={m.id} style={{ background: "#fff", borderRadius: 10, padding: 12, marginBottom: 6, fontSize: 12, border: "1px solid #eee" }}><div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ fontWeight: 600 }}>{m.channel.toUpperCase()}</span><span style={{ color: "#999" }}>{new Date(m.sentAt).toLocaleDateString()}</span></div><div style={{ color: "#555", marginTop: 4 }}>{m.message.slice(0, 80)}{m.message.length > 80 ? "..." : ""}</div></div>)}</div>}
              </div>}
              {msgTab === "auto" && <div>
                {campaigns.map((c) => <div key={c.id} style={{ background: "#fff", borderRadius: 14, padding: 16, marginBottom: 10, border: "1px solid #eee" }}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div style={{ display: "flex", alignItems: "center", gap: 10 }}><span style={{ fontSize: 24 }}>{c.icon}</span><div><div style={{ fontWeight: 700, fontSize: 14 }}>{c.title}</div><div style={{ fontSize: 11, color: "#777" }}>{c.trigger}</div></div></div><button onClick={async () => await sv({ ...salon, campaigns: campaigns.map((x) => x.id === c.id ? { ...x, active: !x.active } : x) })} style={{ padding: "6px 14px", borderRadius: 8, border: "none", background: c.active ? "#2ec4b622" : "#eee", color: c.active ? "#2ec4b6" : "#999", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>{c.active ? "Active" : "Off"}</button></div></div>)}
                <Btn variant="outline" color={ac} onClick={() => addCamp({ type: "custom", icon: "📧", title: "New Campaign", trigger: "Manual", msg: "" })} style={{ borderRadius: 12, marginTop: 8, fontSize: 12 }}>+ Add Campaign</Btn>
              </div>}
            </div>}

            {/* ── Brand ── */}
            {moreTab === "brand" && <div>
              <div style={{ marginBottom: 20 }}>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#777", marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>Logo</label>
                <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                  <div style={{ width: 80, height: 80, borderRadius: 20, background: salon.accent + "15", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", border: "2px solid #eee" }}>
                    {salon.logo?.startsWith("data:") ? <img src={salon.logo} style={{ width: 80, height: 80, objectFit: "cover" }} /> : <span style={{ fontSize: 40 }}>{salon.logo}</span>}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <label style={{ padding: "8px 16px", borderRadius: 10, background: salon.accent, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", textAlign: "center" }}>
                      Upload Logo
                      <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) { const r = new FileReader(); r.onload = (ev) => { const img = new Image(); img.onload = () => { const c = document.createElement("canvas"), mx = 256, s = Math.min(mx / img.width, mx / img.height, 1); c.width = img.width * s; c.height = img.height * s; c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); sv({ ...salon, logo: c.toDataURL("image/jpeg", 0.8) }); }; img.src = ev.target.result; }; r.readAsDataURL(f); } }} />
                    </label>
                    {salon.logo?.startsWith("data:") && <button onClick={async () => await sv({ ...salon, logo: "\u2702\uFE0F" })} style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #eee", background: "#fff", fontSize: 11, color: "#e74c3c", cursor: "pointer", fontFamily: "inherit" }}>Remove</button>}
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {["\u2702\uFE0F", "\uD83D\uDC85", "\uD83D\uDC87", "\uD83D\uDC87\u200D\u2640\uFE0F", "\u2728", "\uD83C\uDF3F", "\uD83D\uDC8E", "\uD83C\uDF38"].map((e) => <button key={e} onClick={async () => await sv({ ...salon, logo: e })} style={{ width: 36, height: 36, borderRadius: 10, border: salon.logo === e ? "2px solid " + salon.accent : "2px solid #eee", background: salon.logo === e ? salon.accent + "15" : "#fafafa", cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center" }}>{e}</button>)}
                    </div>
                  </div>
                </div>
              </div>
              <Inp label="Salon Name" value={salon.name} onChange={async (e) => await sv({ ...salon, name: e.target.value })} />
              <Inp label="Tagline" value={salon.tagline} onChange={async (e) => await sv({ ...salon, tagline: e.target.value })} />
              <Inp label="Email" value={salon.email} onChange={async (e) => await sv({ ...salon, email: e.target.value })} />
              <Inp label="Phone" value={salon.phone} onChange={async (e) => await sv({ ...salon, phone: e.target.value })} />
              <Inp label="Address" value={salon.address} onChange={async (e) => await sv({ ...salon, address: e.target.value })} />
              <div style={{ marginBottom: 16 }}><label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#777", marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>Brand Color</label><div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{["#e94560", "#0f3460", "#533483", "#6366f1", "#f4a261", "#2ec4b6", "#e76f51", "#10b981", "#8b5cf6", "#f59e0b"].map((c) => <button key={c} onClick={async () => await sv({ ...salon, accent: c })} style={{ width: 32, height: 32, borderRadius: 8, background: c, border: salon.accent === c ? "3px solid #333" : "3px solid transparent", cursor: "pointer" }} />)}</div></div>
            </div>}

            {/* ── Export ── */}
            {moreTab === "export" && <div>
              <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>Data Export</h3>
              <div style={{ display: "flex", gap: 12, marginBottom: 20 }}><div style={{ flex: 1 }}><Inp label="From" type="date" value={exportRange.from} onChange={(e) => setExportRange({ ...exportRange, from: e.target.value })} /></div><div style={{ flex: 1 }}><Inp label="To" type="date" value={exportRange.to} onChange={(e) => setExportRange({ ...exportRange, to: e.target.value })} /></div></div>
              <div style={{ display: "grid", gap: 10 }}>
                <Btn full color={ac} onClick={exportBookings} style={{ borderRadius: 12 }}><span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}><Ic n="download" sz={16} />Export Bookings (CSV)</span></Btn>
                <Btn full color={ac} onClick={exportClients} style={{ borderRadius: 12 }}><span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}><Ic n="download" sz={16} />Export Clients (CSV)</span></Btn>
                <Btn full color={ac} onClick={exportRevenue} style={{ borderRadius: 12 }}><span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}><Ic n="download" sz={16} />Export Revenue (CSV)</span></Btn>
                <Btn full variant="outline" color={ac} onClick={exportJSON} style={{ borderRadius: 12 }}><span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}><Ic n="download" sz={16} />Full Backup (JSON)</span></Btn>
                <Btn full variant="outline" color={ac} onClick={() => downloadAllICS(upBk, salon)} style={{ borderRadius: 12 }}><span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}><Ic n="calendar" sz={16} />Export Calendar (iCal)</span></Btn>
              </div>
            </div>}

            {/* ── Notifications ── */}
            {moreTab === "notifications" && <div>
              <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>Notification Settings</h3>
              {["confirmations", "cancellationNotify", "waitlistNotify"].map((k) => <div key={k} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: "1px solid #eee" }}><span style={{ fontSize: 14, fontWeight: 600 }}>{{ confirmations: "Booking Confirmations", cancellationNotify: "Cancellation Alerts", waitlistNotify: "Waitlist Notifications" }[k]}</span><button onClick={async () => { const ns = { ...(salon.notificationSettings || {}), [k]: !(salon.notificationSettings?.[k] ?? true) }; await sv({ ...salon, notificationSettings: ns }); }} style={{ padding: "6px 14px", borderRadius: 8, border: "none", background: (salon.notificationSettings?.[k] ?? true) ? "#2ec4b622" : "#eee", color: (salon.notificationSettings?.[k] ?? true) ? "#2ec4b6" : "#999", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>{(salon.notificationSettings?.[k] ?? true) ? "On" : "Off"}</button></div>)}
              <h4 style={{ fontSize: 14, fontWeight: 700, marginTop: 24, marginBottom: 12 }}>Delivery Log</h4>
              {(salon.notifications || []).slice(0, 20).map((n) => <div key={n.id} style={{ background: "#fff", borderRadius: 10, padding: 12, marginBottom: 6, fontSize: 12, border: "1px solid #eee" }}><div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ fontWeight: 600 }}>{n.type}</span><span style={{ padding: "2px 8px", borderRadius: 10, fontSize: 10, fontWeight: 700, background: n.status === "sent" ? "#2ec4b615" : n.status === "failed" ? "#e74c3c15" : "#f0ad4e15", color: n.status === "sent" ? "#2ec4b6" : n.status === "failed" ? "#e74c3c" : "#f0ad4e" }}>{n.status}</span></div><div style={{ color: "#777", marginTop: 4 }}>{n.recipient_name || n.recipient_email} - {n.subject}</div></div>)}
              {!(salon.notifications || []).length && <div style={{ textAlign: "center", opacity: .3, padding: 20, fontSize: 13 }}>No notifications sent yet</div>}
            </div>}

            {/* ── Waitlist ── */}
            {moreTab === "waitlist" && <div>
              <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>Waitlist ({(salon.waitlist || []).filter((w) => w.status === "waiting").length} active)</h3>
              {(salon.waitlist || []).sort((a, b) => (a.preferred_date || "").localeCompare(b.preferred_date || "")).map((w) => {
                const svc = salon.services.find((s) => s.id === w.service_id);
                const stf = salon.staff.find((s) => s.id === w.staff_id);
                return <div key={w.id} style={{ background: "#fff", borderRadius: 14, padding: 14, marginBottom: 8, border: "1px solid #eee" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><div><div style={{ fontWeight: 700, fontSize: 14 }}>{w.client_name}</div><div style={{ fontSize: 12, color: "#777" }}>{svc?.name} {stf ? `with ${stf.name}` : ""} - {w.preferred_date}</div></div><span style={{ fontSize: 10, fontWeight: 700, padding: "3px 10px", borderRadius: 10, background: { waiting: "#f0ad4e15", notified: "#6366f115", booked: "#2ec4b615", expired: "#99915" }[w.status], color: { waiting: "#f0ad4e", notified: "#6366f1", booked: "#2ec4b6", expired: "#999" }[w.status] }}>{w.status}</span></div>
                  {w.status === "waiting" && <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                    <button onClick={async () => { const u = { ...salon, waitlist: (salon.waitlist || []).map((x) => x.id === w.id ? { ...x, status: "notified", notified_at: new Date().toISOString(), expires_at: new Date(Date.now() + 30 * 60000).toISOString() } : x) }; await sv(u); await queueNotification(u, setSalon, { type: "waitlist", channel: "email", recipient_email: w.client_email, recipient_name: w.client_name, subject: renderTemplate(DEFAULT_TEMPLATES.waitlist.subject, { salonName: salon.name }), body: renderTemplate(DEFAULT_TEMPLATES.waitlist.body, { clientName: w.client_name, serviceName: svc?.name || "", date: w.preferred_date, salonName: salon.name }) }); }} style={{ padding: "6px 12px", borderRadius: 8, border: "none", background: ac + "22", color: ac, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>Notify</button>
                    <button onClick={async () => await sv({ ...salon, waitlist: (salon.waitlist || []).filter((x) => x.id !== w.id) })} style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #eee", background: "#fff", fontSize: 11, cursor: "pointer", fontFamily: "inherit", color: "#e74c3c" }}>Remove</button>
                  </div>}
                </div>;
              })}
              {!(salon.waitlist || []).length && <div style={{ textAlign: "center", opacity: .3, padding: 20, fontSize: 13 }}>No waitlist entries</div>}
            </div>}
          </div>}
        </div>}

      </div>

      {/* Floating Add Booking button */}
      <button onClick={() => { setNBk({ cn: "", ce: "", svcId: "", stId: "", date: calD || fd(new Date()), time: "" }); setShowAddBk(true); }} style={{ position: "fixed", bottom: 72, right: 20, width: 56, height: 56, borderRadius: 16, background: ac, color: "#fff", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 6px 24px " + ac + "66", zIndex: 101, fontSize: 24, fontWeight: 300 }}>+</button>

      {/* Bottom Nav - 5 tabs */}
      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "#fff", borderTop: "1px solid #eee", display: "flex", justifyContent: "space-around", padding: "8px 0 env(safe-area-inset-bottom,8px)", zIndex: 100 }}>
        <NB icon="grid" label="Overview" id="overview" />
        <NB icon="calendar" label="Calendar" id="calendar" />
        <NB icon="users" label="Staff" id="staff" />
        <NB icon="phone" label="Clients" id="clients" />
        <NB icon="settings" label="More" id="more" badge={(salon.waitlist || []).filter((w) => w.status === "waiting").length} />
      </div>

      {/* ── Modals ── */}
      {showAddStaff && <Modal title="Add Staff Member" onClose={() => setShowAddStaff(false)}>
        <div style={{ textAlign: "center", marginBottom: 20 }}><Av src={nStaff.avatar} sz={80} bg={nStaff.color + "22"} /></div>
        <div style={{ marginBottom: 16 }}><label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#777", marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>Avatar</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            <label style={{ width: 40, height: 40, borderRadius: 10, border: "2px dashed #ccc", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", background: "#fafafa", fontSize: 16, flexShrink: 0 }}><span style={{ opacity: .5 }}>+</span><input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) readImg(f, (d) => setNStaff({ ...nStaff, avatar: d })); }} /></label>
            {["\uD83E\uDDD1", "\uD83D\uDC68", "\uD83D\uDC69", "\uD83D\uDC68\u200D\uD83E\uDDB1", "\uD83D\uDC69\u200D\uD83E\uDDB0", "\uD83D\uDC71", "\uD83D\uDC71\u200D\u2640\uFE0F", "\uD83D\uDC68\u200D\uD83E\uDDB3", "\uD83E\uDDD4", "\uD83D\uDC69\u200D\uD83E\uDDB1"].map((e) => <button key={e} onClick={() => setNStaff({ ...nStaff, avatar: e })} style={{ width: 40, height: 40, borderRadius: 10, border: nStaff.avatar === e ? "2px solid " + ac : "2px solid #eee", background: nStaff.avatar === e ? ac + "15" : "#fafafa", cursor: "pointer", fontSize: 20, display: "flex", alignItems: "center", justifyContent: "center" }}>{e}</button>)}
          </div>
        </div>
        <Inp label="Name" value={nStaff.name} onChange={(e) => setNStaff({ ...nStaff, name: e.target.value })} placeholder="e.g. James" />
        <Inp label="Role" value={nStaff.role} onChange={(e) => setNStaff({ ...nStaff, role: e.target.value })} placeholder="e.g. Senior Barber" />
        <div style={{ marginBottom: 16 }}><label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#777", marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>Colour</label><div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{["#e94560", "#0f3460", "#533483", "#6366f1", "#f4a261", "#2ec4b6", "#e76f51", "#10b981", "#8b5cf6", "#f59e0b"].map((c) => <button key={c} onClick={() => setNStaff({ ...nStaff, color: c })} style={{ width: 32, height: 32, borderRadius: 8, background: c, border: nStaff.color === c ? "3px solid #333" : "3px solid transparent", cursor: "pointer" }} />)}</div></div>
        <Btn full color={ac} disabled={!nStaff.name} onClick={async () => { await sv({ ...salon, staff: [...salon.staff, { id: uid(), ...nStaff }] }); setShowAddStaff(false); setNStaff({ name: "", role: "", avatar: "\uD83E\uDDD1", color: "#6366f1" }); }}>Add Staff Member</Btn>
      </Modal>}

      {editStaff && <Modal title="Edit Staff Member" onClose={() => setEditStaff(null)}>
        <div style={{ textAlign: "center", marginBottom: 20 }}><Av src={editStaff.avatar} sz={80} bg={editStaff.color + "22"} /></div>
        <Inp label="Name" value={editStaff.name} onChange={(e) => setEditStaff({ ...editStaff, name: e.target.value })} />
        <Inp label="Role" value={editStaff.role} onChange={(e) => setEditStaff({ ...editStaff, role: e.target.value })} />
        <Btn full color={ac} onClick={async () => { await sv({ ...salon, staff: salon.staff.map((s) => s.id === editStaff.id ? editStaff : s) }); setEditStaff(null); }}>Save Changes</Btn>
      </Modal>}

      {showAddSvc && <Modal title="Add Service" onClose={() => setShowAddSvc(false)}>
        <Inp label="Name" value={nSvc.name} onChange={(e) => setNSvc({ ...nSvc, name: e.target.value })} placeholder="e.g. Classic Cut" />
        <div style={{ display: "flex", gap: 12 }}><div style={{ flex: 1 }}><Inp label="Duration (min)" type="number" value={nSvc.duration} onChange={(e) => setNSvc({ ...nSvc, duration: Number(e.target.value) })} /></div><div style={{ flex: 1 }}><Inp label="Price" type="number" value={nSvc.price} onChange={(e) => setNSvc({ ...nSvc, price: Number(e.target.value) })} /></div></div>
        <Inp label="Category" value={nSvc.category} onChange={(e) => setNSvc({ ...nSvc, category: e.target.value })} placeholder="e.g. Haircuts" />
        <Btn full color={ac} disabled={!nSvc.name || !nSvc.category} onClick={async () => { await sv({ ...salon, services: [...salon.services, { id: uid(), ...nSvc }] }); setShowAddSvc(false); setNSvc({ name: "", duration: 30, price: 0, category: "" }); }}>Add Service</Btn>
      </Modal>}

      {editSvc && <Modal title="Edit Service" onClose={() => setEditSvc(null)}>
        <Inp label="Name" value={editSvc.name} onChange={(e) => setEditSvc({ ...editSvc, name: e.target.value })} />
        <div style={{ display: "flex", gap: 12 }}><div style={{ flex: 1 }}><Inp label="Duration" type="number" value={editSvc.duration} onChange={(e) => setEditSvc({ ...editSvc, duration: Number(e.target.value) })} /></div><div style={{ flex: 1 }}><Inp label="Price" type="number" value={editSvc.price} onChange={(e) => setEditSvc({ ...editSvc, price: Number(e.target.value) })} /></div></div>
        <Inp label="Category" value={editSvc.category} onChange={(e) => setEditSvc({ ...editSvc, category: e.target.value })} />
        <Btn full color={ac} onClick={async () => { await sv({ ...salon, services: salon.services.map((s) => s.id === editSvc.id ? editSvc : s) }); setEditSvc(null); }}>Save</Btn>
      </Modal>}

      {showAddBk && <Modal title="Add Booking" onClose={() => setShowAddBk(false)}>
        <Inp label="Client Name" value={nBk.cn} onChange={(e) => setNBk({ ...nBk, cn: e.target.value })} />
        <Inp label="Client Email" type="email" value={nBk.ce} onChange={(e) => setNBk({ ...nBk, ce: e.target.value })} />
        <div style={{ marginBottom: 16 }}><label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#777", marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>Service</label><select value={nBk.svcId} onChange={(e) => setNBk({ ...nBk, svcId: e.target.value })} style={{ width: "100%", padding: "12px 14px", border: "2px solid #eee", borderRadius: 12, fontSize: 15, fontFamily: "inherit" }}><option value="">Choose...</option>{salon.services.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.duration}min - {s.price})</option>)}</select></div>
        <div style={{ marginBottom: 16 }}><label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#777", marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>Staff</label><select value={nBk.stId} onChange={(e) => setNBk({ ...nBk, stId: e.target.value })} style={{ width: "100%", padding: "12px 14px", border: "2px solid #eee", borderRadius: 12, fontSize: 15, fontFamily: "inherit" }}><option value="">Choose...</option>{salon.staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
        <div style={{ display: "flex", gap: 12 }}><div style={{ flex: 1 }}><Inp label="Date" type="date" value={nBk.date} onChange={(e) => setNBk({ ...nBk, date: e.target.value })} /></div><div style={{ flex: 1 }}><Inp label="Time" type="time" value={nBk.time} onChange={(e) => setNBk({ ...nBk, time: e.target.value })} /></div></div>
        <Btn full color={ac} disabled={!nBk.cn || !nBk.svcId || !nBk.stId || !nBk.date || !nBk.time} onClick={addBk}>Add Booking</Btn>
      </Modal>}

      {staffLoginModal && <Modal title="Create Staff Login" onClose={() => setStaffLoginModal(null)}>
        <p style={{ fontSize: 13, color: "#777", marginBottom: 16 }}>Create login credentials for <strong>{salon.staff.find((s) => s.id === staffLoginModal)?.name}</strong></p>
        <Inp label="Email" type="email" value={staffLoginEmail} onChange={(e) => setStaffLoginEmail(e.target.value)} />
        <Inp label="Password" type="password" value={staffLoginPw} onChange={(e) => setStaffLoginPw(e.target.value)} placeholder="Min 6 characters" />
        <Btn full color={ac} disabled={!staffLoginEmail || !staffLoginPw || staffLoginPw.length < 6} onClick={createStaffLogin}>Create Login</Btn>
      </Modal>}

      {confirm && <div style={{ position: "fixed", inset: 0, zIndex: 999, display: "flex", alignItems: "center", justifyContent: "center" }}><div onClick={() => setConfirm(null)} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.5)" }} /><div style={{ position: "relative", background: "#fff", borderRadius: 20, padding: 28, width: "min(90vw,380px)", textAlign: "center" }}>{confirm.type === "cancel" && <><h3 style={{ margin: "0 0 8px", fontSize: 18, fontWeight: 700 }}>Cancel Booking?</h3><p style={{ opacity: .5, fontSize: 13, margin: "0 0 20px" }}>Slot will be freed.</p><div style={{ display: "flex", gap: 10 }}><Btn full variant="outline" onClick={() => setConfirm(null)} style={{ borderRadius: 12 }}>Keep</Btn><Btn full color="#e74c3c" onClick={() => cancelBk(confirm.id)} style={{ borderRadius: 12 }}>Cancel</Btn></div></>}{confirm.type === "noshow" && <><h3 style={{ margin: "0 0 8px", fontSize: 18, fontWeight: 700 }}>Mark No Show?</h3><p style={{ opacity: .5, fontSize: 13, margin: "0 0 20px" }}>Recorded on client profile.</p><div style={{ display: "flex", gap: 10 }}><Btn full variant="outline" onClick={() => setConfirm(null)} style={{ borderRadius: 12 }}>Back</Btn><Btn full color="#f0ad4e" onClick={() => noShow(confirm.id)} style={{ borderRadius: 12 }}>Confirm</Btn></div></>}</div></div>}
    </div>
  );
};

// ══════════════════════════════════════════════════
// ── MAIN APP ──
// ══════════════════════════════════════════════════
export default function App() {
  const [route, setRoute] = useState(() => { const h = window.location.hash.slice(1); return h || "platform"; }); const [salons, setSalons] = useState({}); const [loading, setLoading] = useState(true); const [createMode, setCreateMode] = useState(false); const [nSalon, setNSalon] = useState({ name: "", tagline: "", email: "", password: "" }); const [searchQ, setSearchQ] = useState("");
  const [loginModal, setLoginModal] = useState(null); const [lEmail, setLEmail] = useState(""); const [lPw, setLPw] = useState(""); const [lName, setLName] = useState(""); const [lErr, setLErr] = useState(""); const [navMenu, setNavMenu] = useState(null);
  const resetL = () => { setLEmail(""); setLPw(""); setLName(""); setLErr(""); };

  const bizLogin = async () => {
    setLErr(""); if (!lEmail || !lPw) return setLErr("Enter email and password.");
    if (!rateLimiter("biz:" + lEmail)) return setLErr("Too many attempts.");
    const sids = Object.keys(salons);
    for (let i = 0; i < sids.length; i++) {
      const oa = await S.getAccount("oa:" + sids[i]);
      if (oa && oa.email === lEmail.toLowerCase() && oa.password === lPw) { setLoginModal(null); resetL(); setRoute("admin:" + sids[i]); return; }
    }
    setLErr("No matching account.");
  };

  const custLogin = async () => {
    setLErr(""); if (!lEmail || !lPw) return setLErr("Enter email and password.");
    if (!rateLimiter("cust:" + lEmail)) return setLErr("Too many attempts.");
    const sids = Object.keys(salons);
    for (let i = 0; i < sids.length; i++) {
      const ac = await S.getAccount("ac:" + sids[i] + ":" + lEmail.toLowerCase());
      if (ac && ac.password === lPw) { await S.setSession("cs:" + sids[i], { loggedIn: true, name: ac.name, phone: ac.phone || "", email: ac.email }); setLoginModal(null); resetL(); setRoute("salon:" + sids[i]); return; }
    }
    setLErr("No account found.");
  };

  const staffLogin = async () => {
    setLErr(""); if (!lEmail || !lPw) return setLErr("Enter email and password.");
    if (!rateLimiter("staff:" + lEmail)) return setLErr("Too many attempts.");
    const sids = Object.keys(salons);
    for (const sid of sids) {
      const sl = salons[sid];
      for (const st of (sl.staff || [])) {
        if (st.email === lEmail.toLowerCase()) {
          const acc = await S.getAccount("st:" + sid + ":" + st.id);
          if (acc && acc.password === lPw) { setLoginModal(null); resetL(); setRoute("staff:" + sid + ":" + st.id); return; }
        }
      }
    }
    setLErr("No staff account found.");
  };

  const custReg = async () => {
    setLErr(""); if (!lName || !lEmail || !lPw) return setLErr("Fill all fields."); if (lPw.length < 6) return setLErr("Password min 6 chars.");
    const sids = Object.keys(salons); if (!sids.length) return setLErr("No businesses yet.");
    for (let i = 0; i < sids.length; i++) { const ex = await S.getAccount("ac:" + sids[i] + ":" + lEmail.toLowerCase()); if (ex) return setLErr("Account exists."); }
    for (let i = 0; i < sids.length; i++) {
      await S.setAccount("ac:" + sids[i] + ":" + lEmail.toLowerCase(), { name: lName, email: lEmail.toLowerCase(), phone: "", password: lPw });
      const sl = salons[sids[i]];
      if (sl && !sl.clients?.find((c) => c.email === lEmail.toLowerCase())) {
        const u = { ...sl, clients: [...(sl.clients || []), { id: uid(), name: lName, phone: "", email: lEmail.toLowerCase(), visits: 0, lastVisit: "", noShows: 0 }] };
        await S.saveFullSalon(u); setSalons((p) => ({ ...p, [sids[i]]: u }));
      }
    }
    await S.setSession("cs:" + sids[0], { loggedIn: true, name: lName, phone: "", email: lEmail.toLowerCase() });
    setLoginModal(null); resetL(); setRoute("salon:" + sids[0]);
  };

  const createSalon = async () => {
    if (!nSalon.email || !nSalon.password || nSalon.password.length < 6 || !nSalon.name) return;
    const slug = nSalon.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
    const cols = ["#1a1a2e", "#0d1b2a", "#2d1b2e"]; const acs = ["#e94560", "#f4a261", "#2ec4b6"];
    const i = Object.keys(salons).length;
    const s = { id: slug, name: nSalon.name, tagline: nSalon.tagline || "Book with us", color: cols[i % 3], accent: acs[i % 3], logo: "\u2702\uFE0F", phone: "", email: nSalon.email, address: "", hours: { mon: "09:00-18:00", tue: "09:00-18:00", wed: "09:00-18:00", thu: "09:00-18:00", fri: "09:00-18:00", sat: "10:00-16:00", sun: "Closed" }, staff: [], services: [], holidays: [], bookings: [], clients: [], reviews: [], waitlist: [], notifications: [], notificationTemplates: [], oohRequests: [], staffHolidays: [], messageLog: [], campaigns: [], notificationSettings: { reminderHours: [24, 2], confirmations: true, cancellationNotify: true, waitlistNotify: true } };
    await S.saveFullSalon(s);
    await S.setAccount("oa:" + slug, { email: nSalon.email.toLowerCase(), password: nSalon.password });
    setSalons((p) => ({ ...p, [slug]: s })); setCreateMode(false); setNSalon({ name: "", tagline: "", email: "", password: "" }); setRoute("admin:" + slug);
  };

  // Sync route to URL hash
  useEffect(() => {
    if (route === "platform") { window.location.hash = ""; } else { window.location.hash = route; }
  }, [route]);

  // Listen for hash changes (back/forward browser navigation)
  useEffect(() => {
    const onHash = () => { const h = window.location.hash.slice(1); setRoute(h || "platform"); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Update manifest when viewing a salon
  useEffect(() => {
    if (route.startsWith("salon:") && salons[route.split(":")[1]]) {
      setSalonManifest(salons[route.split(":")[1]]);
    } else if (!route.startsWith("salon:")) {
      resetManifest();
    }
  }, [route, salons]);

  // Capture PWA install prompt for Android
  useEffect(() => {
    const handler = (e) => { e.preventDefault(); window._deferredPrompt = e; };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  useEffect(() => {
    (async () => {
      const loaded = await S.listSalons();
      if (!Object.keys(loaded).length) {
        const entries = Object.entries(DEMO);
        for (const [k, v] of entries) await S.saveFullSalon(v);
        // Create demo owner accounts
        await S.setAccount("oa:luxe-cuts", { email: "hello@luxecuts.com", password: "demo123" });
        await S.setAccount("oa:glow-studio", { email: "book@glowstudio.com", password: "demo123" });
        setSalons(DEMO);
      } else {
        setSalons(loaded);
      }
      setLoading(false);
    })();
  }, []);

  const updateSalon = (u) => setSalons((p) => ({ ...p, [u.id]: u }));

  if (loading) return <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0a0a0a" }}><link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;700&display=swap" rel="stylesheet" /><div style={{ color: "#fff", fontSize: 18, opacity: .5, fontFamily: "'DM Sans'" }}>Loading...</div></div>;

  if (route.startsWith("salon:")) { const sl = salons[route.split(":")[1]]; return sl ? <CustomerApp salon={sl} setSalon={updateSalon} /> : <div style={{ padding: 40 }}>Not found</div>; }
  if (route.startsWith("admin:")) { const sl = salons[route.split(":")[1]]; return sl ? <OwnerDash salon={sl} setSalon={updateSalon} onLogout={() => setRoute("platform")} /> : <div style={{ padding: 40 }}>Not found</div>; }
  if (route.startsWith("staff:")) { const parts = route.split(":"); const sl = salons[parts[1]]; return sl ? <StaffDash salon={sl} setSalon={updateSalon} staffId={parts[2]} onLogout={() => setRoute("platform")} /> : <div style={{ padding: 40 }}>Not found</div>; }
  if (route === "super-admin") return <SuperAdminDash salons={salons} onLogout={() => setRoute("platform")} />;

  return (
    <div style={{ minHeight: "100vh", background: "#0a0a0a", color: "#fff", fontFamily: "'DM Sans',sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700;800&family=Playfair+Display:wght@700&display=swap" rel="stylesheet" />
      <style>{"@keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}.fade-up{animation:fadeUp .5s ease forwards}.salon-card{transition:all .25s}.salon-card:hover{transform:translateY(-4px);box-shadow:0 12px 40px rgba(0,0,0,0.4)}::-webkit-scrollbar{display:none}"}</style>
      <div style={{ position: "sticky", top: 0, zIndex: 100, background: "rgba(10,10,10,0.85)", backdropFilter: "blur(12px)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ maxWidth: 600, margin: "0 auto", padding: "12px 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontFamily: "'Playfair Display',serif", fontSize: 20, fontWeight: 700 }}>Book<span style={{ color: "#e94560" }}>.</span>app</div>
          <div style={{ display: "flex", gap: 8 }}>
            {["biz", "staff", "cust"].map((t) => <div key={t} style={{ position: "relative" }}>
              <button onClick={() => setNavMenu(navMenu === t ? null : t)} style={{ background: navMenu === t ? (t === "biz" ? "#e94560" : t === "staff" ? "#10b981" : "#6366f1") : "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.12)", color: "#fff", borderRadius: 10, padding: "7px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{{ biz: "Business", staff: "Staff", cust: "Customer" }[t]}</button>
              {navMenu === t && <><div onClick={() => setNavMenu(null)} style={{ position: "fixed", inset: 0, zIndex: 98 }} /><div style={{ position: "absolute", right: 0, top: "calc(100% + 8px)", background: "#1a1a2e", borderRadius: 14, border: "1px solid rgba(255,255,255,0.1)", width: 180, zIndex: 99, boxShadow: "0 16px 48px rgba(0,0,0,0.6)", padding: "6px 0" }}>
                {t !== "staff" && <button onClick={() => { setNavMenu(null); if (t === "biz") setCreateMode(true); else { setLoginModal("cust-reg"); resetL(); } }} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "12px 16px", border: "none", background: "none", color: "#fff", cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}><Ic n="plus" sz={14} />Register</button>}
                <button onClick={() => { setNavMenu(null); setLoginModal(t === "biz" ? "biz-login" : t === "staff" ? "staff-login" : "cust-login"); resetL(); }} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "12px 16px", border: "none", background: "none", color: "#fff", cursor: "pointer", fontFamily: "inherit", fontSize: 13 }}><Ic n="settings" sz={14} />Login</button>
              </div></>}
            </div>)}
          </div>
        </div>
      </div>
      <div style={{ maxWidth: 600, margin: "0 auto", padding: "0 20px" }}>
        <div className="fade-up" style={{ paddingTop: 48, textAlign: "center" }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 4, opacity: .3, marginBottom: 16 }}>Booking Platform</div>
          <h1 style={{ margin: 0, fontSize: 42, fontFamily: "'Playfair Display',serif", fontWeight: 700 }}>Book<span style={{ color: "#e94560" }}>.</span>app</h1>
          <p style={{ opacity: .4, margin: "12px auto 0", fontSize: 15, maxWidth: 340, lineHeight: 1.6 }}>Beautiful booking pages for salons, barbers & beauty studios.</p>
        </div>
        <div style={{ marginTop: 48 }}>
          <div style={{ position: "relative", marginBottom: 20 }}>
            <div style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", opacity: .3 }}><Ic n="eye" sz={16} /></div>
            <input value={searchQ} onChange={(e) => setSearchQ(e.target.value)} placeholder="Search salons, barbers, studios..." style={{ width: "100%", padding: "14px 14px 14px 40px", borderRadius: 14, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.06)", color: "#fff", fontSize: 14, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }} />
            {searchQ && <button onClick={() => setSearchQ("")} style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "rgba(255,255,255,0.3)", cursor: "pointer", padding: 4 }}><Ic n="x" sz={14} /></button>}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}><h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Businesses</h2><button onClick={() => setCreateMode(true)} style={{ background: "rgba(255,255,255,0.08)", border: "none", color: "#fff", borderRadius: 10, padding: "8px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>+ New</button></div>
          {Object.values(salons).filter((s) => !searchQ || s.name.toLowerCase().includes(searchQ.toLowerCase()) || s.tagline?.toLowerCase().includes(searchQ.toLowerCase()) || s.address?.toLowerCase().includes(searchQ.toLowerCase()) || (s.services || []).some((sv) => sv.name.toLowerCase().includes(searchQ.toLowerCase()) || sv.category?.toLowerCase().includes(searchQ.toLowerCase()))).map((s, i) => {
            const avgR = (s.reviews || []).filter((r) => !r.hidden); const avg = avgR.length ? (avgR.reduce((t, r) => t + r.rating, 0) / avgR.length).toFixed(1) : null;
            return <div key={s.id} className="salon-card fade-up" style={{ background: s.color, borderRadius: 20, padding: 24, marginBottom: 16, animationDelay: i * .08 + "s", animationFillMode: "both" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>{s.logo?.startsWith("data:") ? <img src={s.logo} style={{ width: 48, height: 48, borderRadius: 12, objectFit: "cover" }} /> : <div style={{ fontSize: 36 }}>{s.logo}</div>}<div><h3 style={{ margin: "0 0 4px", fontSize: 20, fontFamily: "'Playfair Display',serif" }}>{s.name}</h3><p style={{ opacity: .5, margin: 0, fontSize: 13 }}>{s.tagline}</p>{avg && <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 4 }}><Stars rating={Math.round(Number(avg))} sz={12} /><span style={{ fontSize: 12, opacity: .6 }}>{avg}</span></div>}</div></div>
              <div style={{ display: "flex", gap: 10, marginTop: 18, paddingTop: 16, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                <button onClick={() => setRoute("salon:" + s.id)} style={{ flex: 1, padding: 12, borderRadius: 12, border: "none", background: s.accent, color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Customer View</button>
                <button onClick={() => setRoute("admin:" + s.id)} style={{ flex: 1, padding: 12, borderRadius: 12, border: "1px solid rgba(255,255,255,0.2)", background: "transparent", color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>Dashboard</button>
              </div>
              <div style={{ marginTop: 10, fontSize: 11, opacity: .25, textAlign: "center" }}>Demo mode</div>
            </div>;
          })}
        </div>
        {searchQ && !Object.values(salons).some((s) => s.name.toLowerCase().includes(searchQ.toLowerCase()) || s.tagline?.toLowerCase().includes(searchQ.toLowerCase()) || s.address?.toLowerCase().includes(searchQ.toLowerCase()) || (s.services || []).some((sv) => sv.name.toLowerCase().includes(searchQ.toLowerCase()) || sv.category?.toLowerCase().includes(searchQ.toLowerCase()))) && <div style={{ textAlign: "center", padding: "30px 0", opacity: .3, fontSize: 14 }}>No businesses found for "{searchQ}"</div>}
        {/* Super Admin link (hidden) */}
        <div style={{ textAlign: "center", marginTop: 40, marginBottom: 40 }}>
          <button onClick={() => setRoute("super-admin")} style={{ background: "none", border: "none", color: "rgba(255,255,255,0.08)", fontSize: 10, cursor: "pointer", fontFamily: "inherit" }}>Admin</button>
        </div>
      </div>

      {createMode && <Modal title="Register Business" onClose={() => setCreateMode(false)}><Inp label="Business Name" value={nSalon.name} onChange={(e) => setNSalon({ ...nSalon, name: e.target.value })} /><Inp label="Tagline" value={nSalon.tagline} onChange={(e) => setNSalon({ ...nSalon, tagline: e.target.value })} />{nSalon.name && <div style={{ fontSize: 13, opacity: .5, marginBottom: 16 }}>URL: bookings.app/{nSalon.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}</div>}<div style={{ height: 1, background: "#eee", margin: "8px 0 16px" }} /><Inp label="Owner Email" value={nSalon.email} onChange={(e) => setNSalon({ ...nSalon, email: e.target.value })} type="email" /><Inp label="Password" value={nSalon.password} onChange={(e) => setNSalon({ ...nSalon, password: e.target.value })} type="password" /><Btn full color="#111" disabled={!nSalon.name || !nSalon.email || !nSalon.password || nSalon.password.length < 6} onClick={createSalon}>Create</Btn></Modal>}

      {loginModal === "biz-login" && <Modal title="Business Login" onClose={() => { setLoginModal(null); resetL(); }}><Inp label="Email" value={lEmail} onChange={(e) => { setLEmail(e.target.value); setLErr(""); }} type="email" /><Inp label="Password" value={lPw} onChange={(e) => { setLPw(e.target.value); setLErr(""); }} type="password" />{lErr && <div style={{ background: "#e74c3c12", borderRadius: 10, padding: "10px 14px", marginBottom: 12, fontSize: 13, color: "#e74c3c" }}>{lErr}</div>}<Btn full color="#e94560" onClick={bizLogin} style={{ borderRadius: 12 }}>Sign In</Btn></Modal>}

      {loginModal === "staff-login" && <Modal title="Staff Login" onClose={() => { setLoginModal(null); resetL(); }}><Inp label="Email" value={lEmail} onChange={(e) => { setLEmail(e.target.value); setLErr(""); }} type="email" /><Inp label="Password" value={lPw} onChange={(e) => { setLPw(e.target.value); setLErr(""); }} type="password" />{lErr && <div style={{ background: "#e74c3c12", borderRadius: 10, padding: "10px 14px", marginBottom: 12, fontSize: 13, color: "#e74c3c" }}>{lErr}</div>}<Btn full color="#10b981" onClick={staffLogin} style={{ borderRadius: 12 }}>Sign In</Btn></Modal>}

      {loginModal === "cust-login" && <Modal title="Customer Login" onClose={() => { setLoginModal(null); resetL(); }}><Inp label="Email" value={lEmail} onChange={(e) => { setLEmail(e.target.value); setLErr(""); }} type="email" /><Inp label="Password" value={lPw} onChange={(e) => { setLPw(e.target.value); setLErr(""); }} type="password" />{lErr && <div style={{ background: "#e74c3c12", borderRadius: 10, padding: "10px 14px", marginBottom: 12, fontSize: 13, color: "#e74c3c" }}>{lErr}</div>}<Btn full color="#6366f1" onClick={custLogin} style={{ borderRadius: 12 }}>Sign In</Btn><p style={{ fontSize: 12, opacity: .4, textAlign: "center", marginTop: 14 }}>No account? <button onClick={() => { setLoginModal("cust-reg"); resetL(); }} style={{ background: "none", border: "none", color: "#6366f1", cursor: "pointer", fontFamily: "inherit", fontWeight: 600, fontSize: 12 }}>Register</button></p></Modal>}

      {loginModal === "cust-reg" && <Modal title="Create Account" onClose={() => { setLoginModal(null); resetL(); }}><Inp label="Name" value={lName} onChange={(e) => { setLName(e.target.value); setLErr(""); }} /><Inp label="Email" value={lEmail} onChange={(e) => { setLEmail(e.target.value); setLErr(""); }} type="email" /><Inp label="Password" value={lPw} onChange={(e) => { setLPw(e.target.value); setLErr(""); }} type="password" placeholder="Min 6 chars" />{lErr && <div style={{ background: "#e74c3c12", borderRadius: 10, padding: "10px 14px", marginBottom: 12, fontSize: 13, color: "#e74c3c" }}>{lErr}</div>}<Btn full color="#6366f1" onClick={custReg} style={{ borderRadius: 12 }}>Create Account</Btn><p style={{ fontSize: 12, opacity: .4, textAlign: "center", marginTop: 14 }}>Have account? <button onClick={() => { setLoginModal("cust-login"); resetL(); }} style={{ background: "none", border: "none", color: "#6366f1", cursor: "pointer", fontFamily: "inherit", fontWeight: 600, fontSize: 12 }}>Sign In</button></p></Modal>}
    </div>
  );
}
