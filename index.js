(() => {
  const { metro, plugin, storage: vstorage, ui } = vendetta;
  const storage = plugin.storage;
  const { React, ReactNative: RN } = metro.common;

  const PATTERN = /guild|server|account|user.?(bar|card|panel|area)|panel|call|voice|private|friend|dm|chat|message|tab|bottom|sidebar|home|sheet|navigat|layout|container|stage|participant|pip|mini/i;

  const nameOf = (fn) => {
    try {
      return fn.displayName || fn.name || "";
    } catch (e) {
      return "";
    }
  };

  const scan = () => {
    const found = new Set();
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
          if (n && n.length < 60 && PATTERN.test(n)) found.add(n);
        }
        if (t === "object" || t === "function") {
          const d = ex.default;
          if (typeof d === "function") {
            const n = nameOf(d);
            if (n && n.length < 60 && PATTERN.test(n)) found.add(n);
          }
          if (t === "object") {
            const keys = Object.keys(ex);
            if (keys.length < 80) {
              for (let i = 0; i < keys.length; i++) {
                const k = keys[i];
                if (k.length < 60 && PATTERN.test(k) && typeof ex[k] === "function") found.add(k);
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
    const { ScrollView, Text } = RN;
    const text = storage.last || "";
    if (!Forms || !Forms.FormRow) {
      return React.createElement(Text, { style: { color: "#fff", padding: 16 } }, "Settings UI unavailable.");
    }
    const clip = metro.findByProps("setString");
    return React.createElement(
      ScrollView,
      null,
      React.createElement(
        Forms.FormSection,
        { title: "SnoozyInspector", titleStyleType: "no_border" },
        React.createElement(Forms.FormRow, {
          label: "Scan now",
          subLabel: "Open Home, a DM, and a DM call first, then scan.",
          onPress: () => {
            try {
              const list = scan();
              storage.last = list.slice(0, 400).join("\n");
              setStatus("Found " + list.length + " names");
            } catch (e) {
              setStatus("Scan failed: " + e);
            }
          },
        }),
        React.createElement(Forms.FormRow, {
          label: "Copy results",
          subLabel: status || "Copies the list so you can paste it to Claude.",
          onPress: () => {
            try {
              if (clip && text) {
                clip.setString(text);
                setStatus("Copied");
              } else {
                setStatus("Nothing to copy yet");
              }
            } catch (e) {
              setStatus("Copy failed");
            }
          },
        }),
        React.createElement(Text, { selectable: true, style: { color: "#fff", padding: 16, fontSize: 12 } }, text)
      )
    );
  };

  return { onLoad() {}, onUnload() {}, settings: Settings };
})()
