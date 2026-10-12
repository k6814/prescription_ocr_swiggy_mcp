import React, { useEffect, useState } from "react";
import {
  SafeAreaView, ScrollView, View, Text, TextInput, TouchableOpacity,
  Linking, StyleSheet, ActivityIndicator,
} from "react-native";
import { api, saveToken, loadToken, clearToken } from "./api";

export default function App() {
  const [hasToken, setHasToken] = useState(null);
  const [tokenInput, setTokenInput] = useState("");
  const [me, setMe] = useState(null);
  const [connected, setConnected] = useState(false);
  const [addresses, setAddresses] = useState([]);
  const [addressId, setAddressId] = useState(null);
  const [requestText, setRequestText] = useState("");
  const [preview, setPreview] = useState(null);
  const [cart, setCart] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { (async () => setHasToken(Boolean(await loadToken())))(); }, []);
  useEffect(() => { if (hasToken) refresh(); }, [hasToken]);

  const refresh = async () => {
    setError(null);
    try {
      const s = await api.status();
      setMe(s.user);
      setConnected(s.connected);
      if (s.connected) {
        const { addresses } = await api.addresses();
        setAddresses(addresses);
        if (addresses.length === 1) setAddressId(addresses[0].id);
      }
    } catch (e) {
      setError(e.message);
      if (e.status === 401) { await clearToken(); setHasToken(false); }
    }
  };

  const handleSaveToken = async () => {
    if (!tokenInput.trim()) return;
    await saveToken(tokenInput.trim());
    setTokenInput("");
    setHasToken(true);
  };

  const handleConnect = async () => {
    setError(null);
    try {
      const { url } = await api.authLink();
      Linking.openURL(url);
    } catch (e) { setError(e.message); }
  };

  const handleDisconnect = async () => {
    try { await api.disconnect(); } catch {}
    setConnected(false); setAddresses([]); setAddressId(null); setPreview(null);
  };

  const handlePreview = async () => {
    setError(null); setBusy(true);
    try {
      const { results } = await api.preview(requestText, addressId);
      setPreview(results.map((r) => ({
        ...r,
        chosenIndex: r.status === "matched" ? 0 : null,
        included: r.status === "matched",
      })));
    } catch (e) {
      setError(e.message);
      if (e.action) setConnected(false); // session expired -> show Connect again
    } finally { setBusy(false); }
  };

  const handleConfirm = async () => {
    const selections = preview
      .filter((r) => r.included && r.chosenIndex !== null)
      .map((r) => {
        const o = r.options[r.chosenIndex];
        // o.quantity is already clamped to that variant's maxQuantity
        return { spinId: o.spinId, skuId: o.skuId, quantity: o.quantity };
      });
    if (!selections.length) return setError("Nothing selected.");
    setError(null); setBusy(true);
    try {
      await api.confirm(addressId, selections);
      const { cart } = await api.cart();
      setCart(cart); setPreview(null); setRequestText("");
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  // --- first launch: paste your personal token ---
  if (hasToken === false) {
    return (
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.title}>Enter your access token</Text>
          <Text style={styles.help}>
            The person running the backend gives you this. It's stored in your
            device keychain and identifies you -- don't share it.
          </Text>
          <TextInput
            style={styles.input}
            placeholder="paste token"
            value={tokenInput}
            onChangeText={setTokenInput}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
          />
          <TouchableOpacity onPress={handleSaveToken} style={styles.primaryBtn}>
            <Text style={styles.primaryBtnText}>Save</Text>
          </TouchableOpacity>
          {error && <Text style={styles.error}>{error}</Text>}
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (hasToken === null) {
    return <SafeAreaView style={styles.container}><ActivityIndicator style={{marginTop:60}} /></SafeAreaView>;
  }

  const ready = connected && addressId;

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>Instamart NL Cart</Text>

        <View style={styles.statusRow}>
          <Text>{me ? `${me} · ` : ""}{connected ? "connected" : "not connected"}</Text>
          <TouchableOpacity onPress={refresh}><Text style={styles.linkText}>Refresh</Text></TouchableOpacity>
        </View>

        {!connected && (
          <TouchableOpacity onPress={handleConnect} style={styles.primaryBtn}>
            <Text style={styles.primaryBtnText}>Connect my Swiggy account</Text>
          </TouchableOpacity>
        )}

        {connected && (
          <View style={styles.block}>
            <Text style={styles.label}>Deliver to</Text>
            {addresses.length === 0 && <Text style={styles.warn}>No saved addresses.</Text>}
            {addresses.map((a) => (
              <TouchableOpacity key={a.id} onPress={() => setAddressId(a.id)}>
                <Text style={addressId === a.id ? styles.optOn : styles.optOff}>
                  [{addressId === a.id ? "x" : " "}] {a.label}
                </Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity onPress={handleDisconnect}>
              <Text style={[styles.linkText, { marginTop: 8 }]}>Disconnect Swiggy</Text>
            </TouchableOpacity>
          </View>
        )}

        {error && <Text style={styles.error}>{error}</Text>}

        <TextInput
          style={styles.input}
          placeholder="e.g. 1 bottle of water"
          value={requestText}
          onChangeText={setRequestText}
          multiline
        />
        <TouchableOpacity
          onPress={handlePreview}
          style={[styles.primaryBtn, (!ready || busy) && styles.disabledBtn]}
          disabled={!ready || busy}
        >
          <Text style={styles.primaryBtnText}>Preview</Text>
        </TouchableOpacity>
        {connected && !addressId && <Text style={styles.warn}>Pick an address first.</Text>}

        {busy && <ActivityIndicator style={{ marginTop: 12 }} />}

        {preview && (
          <View style={styles.block}>
            {preview.map((r, idx) => (
              <View key={idx} style={styles.itemCard}>
                <Text style={styles.itemName}>
                  {r.item.quantity} {r.item.unit ?? ""} {r.item.name}
                </Text>
                {r.status === "matched" && (
                  <TouchableOpacity onPress={() => setPreview((p) => p.map((x,i)=> i===idx?{...x,included:!x.included}:x))}>
                    <Text style={r.included ? styles.optOn : styles.optOff}>
                      [{r.included ? "x" : " "}] {r.options[0].label}
                      {r.options[0].price != null ? `  ₹${r.options[0].price}` : ""}
                      {r.options[0].quantityCapped
                        ? `  (max ${r.options[0].quantity} per order)`
                        : ""}
                    </Text>
                  </TouchableOpacity>
                )}
                {r.status === "ambiguous" && (
                  <View>
                    <Text style={styles.warn}>Pick one:</Text>
                    {r.options.map((o, oi) => (
                      <TouchableOpacity key={oi} onPress={() => setPreview((p)=>p.map((x,i)=> i===idx?{...x,chosenIndex:oi,included:true}:x))}>
                        <Text style={r.chosenIndex === oi ? styles.optOn : styles.optOff}>
                          [{r.chosenIndex === oi ? "x" : " "}] {o.label}
                          {o.price != null ? `  ₹${o.price}` : ""}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
                {r.status === "no_match" && (
                  <Text style={styles.warn}>Nothing matching found — try naming the brand.</Text>
                )}
              </View>
            ))}
            <TouchableOpacity onPress={handleConfirm} style={[styles.primaryBtn, busy && styles.disabledBtn]} disabled={busy}>
              <Text style={styles.primaryBtnText}>Add selected to cart</Text>
            </TouchableOpacity>
          </View>
        )}

        {cart && (
          <View style={styles.block}>
            <Text style={styles.itemName}>Cart after update:</Text>
            <Text style={styles.mono}>{JSON.stringify(cart, null, 2)}</Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  scroll: { padding: 16 },
  title: { fontSize: 20, fontWeight: "600", marginBottom: 12 },
  help: { color: "#555", marginBottom: 12, lineHeight: 20 },
  statusRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  linkText: { color: "#0066cc" },
  label: { fontWeight: "600", marginBottom: 6 },
  block: { marginTop: 18 },
  primaryBtn: { backgroundColor: "#0066cc", padding: 12, borderRadius: 8, alignItems: "center", marginTop: 12 },
  primaryBtnText: { color: "#fff", fontWeight: "600" },
  disabledBtn: { opacity: 0.5 },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10, minHeight: 60, marginTop: 18 },
  error: { color: "#cc0000", marginVertical: 8 },
  itemCard: { borderWidth: 1, borderColor: "#eee", borderRadius: 8, padding: 10, marginBottom: 8 },
  itemName: { fontWeight: "600", marginBottom: 4 },
  optOn: { color: "#0a8a0a", paddingVertical: 3 },
  optOff: { color: "#333", paddingVertical: 3 },
  warn: { color: "#a06000" },
  mono: { fontFamily: "monospace", fontSize: 11 },
});
