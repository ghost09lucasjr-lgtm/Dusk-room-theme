(() => {
  const { metro, plugin, storage: vstorage, ui } = vendetta;
  const storage = plugin.storage;
  const { React, ReactNative: RN } = metro.common;

  const PATTERN = /guild|server|account|user|panel|call|voice|private|friend|dm|channel|chat|message|tab|bottom|sidebar|home|navigat|layout|stage|pip|mini|drawer|nav|rail|header|safearea|screen/i;
  const NOISE = /actionsheet|modal|record|icon|illustration|upsell|badge|manager|tooltip|coachmark|nux|promo|toast|experiment|zod|flywheel|wishlist|collectible|premium|nitro|payment|invoice|settings|forum|event|emoji|sticker|reaction|soundboard|checkpoint|bounty|bounties|devtools|appeal|age|connected|connection|gift|boost|safety|familycenter|activity|game|profile|avatardecoration|nameplate|moderat|audit|invite|webhook|integration|role|ban|automod|captcha|mfa|contact|verification|explicit|typing|poll|attachment|gif|sheet|dialog|alert|popup|preview|skeleton|loading|empty|row$|text$|button$|input$|field|picker|select|dropdown/i;

  const nameOf = (fn) => {
    try {
      return fn.displayName || fn.name || "";
    } catch (e) {
      return "";
    }
  };

  const scan = (filter) => {
    const found = new Set();
    const f = filter ? new RegExp(filter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;
    const ok = (n) => {
      if (!n || n.length > 60) return false;
      if (f) return f.test(n);
      return PATTERN.test(n) && (!NOISE.test(n) || /call/i.test(n));
    };
    const mods = metro.modules || (typeof window !== "undefined" && window.modules) || {};
    for (const id in mods) {
      try {
        const m = mods[id];
        if (!m || !m.isInitialized || !m.publicModule) continue;
        const ex = m.publicModule.exports;
        if (!ex) continue;
        const t = typeof ex;
        if (t === "function") {
          const n = nameOf(ex);
          if (ok(n)) found.add(n);
        }
        if (t === "object" || t === "function") {
          const d = ex.default;
          if (typeof d === "function") {
            const n = nameOf(d);
            if (ok(n)) found.add(n);
          }
          if (t === "object") {
            const keys = Object.keys(ex);
            if (keys.length < 80) {
              for (let i = 0; i < keys.length; i++) {
                const k = keys[i];
                if (ok(k) && typeof ex[k] === "function") found.add(k);
              }
            }
          }
        }
      } catch (e) {}
    }
    return Array.from(found).sort();
  };

  const Settings = () => {
    vstorage.useProxy(storage);
    const [status, setStatus] = React.useState("");
    const Forms = ui.components && ui.components.Forms;
    const { ScrollView, Text, TextInput } = RN;
    const text = storage.last || "";
    if (!Forms || !Forms.FormRow) {
      return React.createElement(Text, { style: { color: "#fff", padding: 16 } }, "Settings UI unavailable.");
    }
    const clip = metro.findByProps("setString");
    const shown = text.split("\n").slice(0, 150).join("\n");
    return React.createElement(
      ScrollView,
      null,
      React.createElement(
        Forms.FormSection,
        { title: "SnoozyInspector", titleStyleType: "no_border" },
        React.createElement(TextInput, {
          value: storage.filter || "",
          onChangeText: (v) => {
            storage.filter = v;
          },
          placeholder: "Optional keyword filter, e.g. Guild",
          placeholderTextColor: "#888",
          style: { color: "#fff", padding: 14 },
        }),
        React.createElement(Forms.FormRow, {
          label: "Scan now",
          subLabel: "Open Home, a DM, and a DM call first, then scan.",
          onPress: () => {
            try {
              const list = scan((storage.filter || "").trim());
              storage.last = list.slice(0, 2000).join("\n");
              setStatus("Found " + list.length + " names");
            } catch (e) {
              setStatus("Scan failed: " + e);
            }
          },
        }),
        React.createElement(Forms.FormRow, {
          label: "Copy ALL results",
          subLabel: status || "Copies the full list so you can paste it to Claude.",
          onPress: () => {
            try {
              if (clip && text) {
                clip.setString(text);
                setStatus("Copied " + text.split("\n").length + " names");
              } else {
                setStatus("Nothing to copy yet");
              }
            } catch (e) {
              setStatus("Copy failed");
            }
          },
        }),
        React.createElement(Text, { selectable: true, style: { color: "#fff", padding: 16, fontSize: 12 } }, shown)
      )
    );
  };

  return { onLoad() {}, onUnload() {}, settings: Settings };
})()
