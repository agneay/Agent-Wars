// Backend origin. Set VITE_API_URL at build time when hosting (e.g. https://aai-api.up.railway.app).
export const API_ORIGIN = (import.meta.env.VITE_API_URL || "http://localhost:5000").replace(/\/$/, "");
