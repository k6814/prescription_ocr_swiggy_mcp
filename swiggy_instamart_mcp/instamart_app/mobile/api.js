import * as SecureStore from "expo-secure-store";
import { BASE_URL } from "./config";

const TOKEN_KEY = "instamart_user_token";

export async function saveToken(token) {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}
export async function loadToken() {
  return SecureStore.getItemAsync(TOKEN_KEY);
}
export async function clearToken() {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

async function call(path, options = {}) {
  const token = await loadToken();
  if (!token) throw new Error("No token set");
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(body.error ?? `${path} failed with ${res.status}`);
    e.status = res.status;
    e.action = body.action;
    throw e;
  }
  return body;
}

export const api = {
  status: () => call("/api/status"),
  authLink: () => call("/api/auth/link"),
  disconnect: () => call("/api/auth/disconnect", { method: "POST" }),
  addresses: () => call("/api/addresses"),
  preview: (text, addressId) =>
    call("/api/cart/preview", { method: "POST", body: JSON.stringify({ text, addressId }) }),
  confirm: (addressId, selections) =>
    call("/api/cart/confirm", { method: "POST", body: JSON.stringify({ addressId, selections }) }),
  cart: () => call("/api/cart"),
};
