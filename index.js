(() => {
  const { patcher, metro, plugin, storage: vstorage, ui } = vendetta;
  const storage = plugin.storage;
  const { React, ReactNative: RN } = metro.common;

  // ---------- config (plain object, so hot paths never touch the storage proxy) ----------
  const cfg = { blocky: true, noAnimations: true, rules: {}, hasRules: false, dump: false, dumpRe: null };
  const DEFAULT_DUMP_RE = /guild|server|account|usertile|panel|call|drawer|tab|chat|channel|friend|dm|conversation|home|safearea|header|messages/i;
  let rulesStatus = "No rules";

  const parseRules = (text) => {
    const obj = JSON.parse(text);
    const out = {};
    for (const k in obj) {
      const v = obj[k];
      if (v && typeof v === "object") {
        const s = {};
        for (const p in v) s[p] = v[p] === null ? undefined : v[p];
        out[k] = s;
      }
    }
    return out;
  };

  const syncCfg = () => {
    cfg.blocky = !!storage.blocky;
    cfg.noAnimations = !!storage.noAnimations;
    cfg.dump = !!storage.dumpOn;
    const f = (storage.dumpFilter || "").trim();
    cfg.dumpRe = f ? new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : DEFAULT_DUMP_RE;
    const text = (storage.rules || "").trim();
    if (!text) {
      cfg.rules = {};
      cfg.hasRules = false;
      rulesStatus = "No rules";
    } else {
      try {
        cfg.rules = parseRules(text);
        cfg.hasRules = Object.keys(cfg.rules).length > 0;
        rulesStatus = "Rules OK (" + Object.keys(cfg.rules).length + ")";
      } catch (e) {
        rulesStatus = "Invalid JSON, keeping previous rules";
      }
    }
  };

  // ---------- helpers ----------
  const RADIUS_KEYS = [
    "borderRadius",
    "borderTopLeftRadius",
    "borderTopRightRadius",
    "borderBottomLeftRadius",
    "borderBottomRightRadius",
    "borderTopStartRadius",
    "borderTopEndRadius",
    "borderBottomStartRadius",
    "borderBottomEndRadius",
  ];

  const squareStyle = (style) => {
    if (!style || typeof style !== "object") return style;
    if (Array.isArray(style)) {
      let changed = false;
      const out = style.map((s) => {
        const n = squareStyle(s);
        if (n !== s) changed = true;
        return n;
      });
      return changed ? out : style;
    }
    let copy = null;
    for (let i = 0; i < RADIUS_KEYS.length; i++) {
      const k = RADIUS_KEYS[i];
      if (style[k]) {
        if (!copy) copy = Object.assign({}, style);
        copy[k] = 0;
      }
    }
    return copy || style;
  };

  const computeName = (t) => {
    try {
      if (t.displayName || t.name) return t.displayName || t.name;
      if (t.type) return computeName(t.type);
      if (t.render) return t.render.displayName || t.render.name || "";
    } catch (e) {}
    return "";
  };

  const nameCache = new WeakMap();
  const nameOfType = (t) => {
    if (typeof t === "string") return t;
    if (!t || (typeof t !== "function" && typeof t !== "object")) return "";
    let n = nameCache.get(t);
    if (n === undefined) {
      n = computeName(t);
      nameCache.set(t, n);
    }
    return n;
  };

  const STYLE_KEYS = ["flexDirection", "flex", "width", "height", "position", "top", "bottom", "left", "right"];
  const styleText = (style) => {
    try {
      const flat = RN.StyleSheet && RN.StyleSheet.flatten ? RN.StyleSheet.flatten(style) : style;
      if (!flat || typeof flat !== "object") return "";
      const parts = [];
      for (let i = 0; i < STYLE_KEYS.length; i++) {
        const v = flat[STYLE_KEYS[i]];
        if (v !== undefined && v !== null) parts.push(STYLE_KEYS[i] + "=" + v);
      }
      return parts.length ? " {" + parts.join(", ") + "}" : "";
    } catch (e) {
      return "";
    }
  };

  const unpatches = [];
  const safe = (fn) => {
    try {
      fn();
    } catch (e) {
      console.log("[SnoozyLayout]", e);
    }
  };

  // ---------- jsx hooks ----------
  const onBefore = (args) => {
    const props = args[1];
    if (!props) return;
    let style = props.style;
    let changed = false;
    if (cfg.hasRules) {
      const name = nameOfType(args[0]);
      const rule = name && cfg.rules[name];
      if (rule) {
        style = style ? [style, rule] : rule;
        changed = true;
      }
    }
    if (cfg.blocky && style) {
      const s = squareStyle(style);
      if (s !== style) {
        style = s;
        changed = true;
      }
    }
    if (changed) args[1] = Object.assign({}, props, { style });
  };

  const map = new Map();
  const onAfter = (args, ret) => {
    if (!cfg.dump || !ret || typeof ret !== "object") return;
    const p = ret.props;
    if (!p) return;
    const ch = p.children;
    if (!ch || typeof ch !== "object") return;
    const arr = Array.isArray(ch) ? ch : [ch];
    if (arr.length > 14 || map.size >= 500) return;
    let hit = false;
    const names = [];
    for (let i = 0; i < arr.length; i++) {
      const c = arr[i];
      if (c && typeof c === "object" && c.type !== undefined) {
        const n = nameOfType(c.type) || "?";
        names.push(n);
        if (cfg.dumpRe.test(n)) hit = true;
      }
    }
    if (!hit) return;
    const line = (nameOfType(ret.type) || "?") + styleText(p.style) + " -> " + names.join(", ");
    if (!map.has(line)) map.set(line, 1);
  };

  const patchJsx = () => {
    const runtime = metro.findByProps("jsx", "jsxs", "Fragment");
    if (runtime) {
      unpatches.push(patcher.before("jsx", runtime, onBefore));
      unpatches.push(patcher.after("jsx", runtime, onAfter));
      if (runtime.jsxs) {
        unpatches.push(patcher.before("jsxs", runtime, onBefore));
        unpatches.push(patcher.after("jsxs", runtime, onAfter));
      }
    }
    const R = metro.findByProps("createElement", "useState");
    if (R) {
      unpatches.push(patcher.before("createElement", R, onBefore));
      unpatches.push(patcher.after("createElement", R, onAfter));
    }
  };

  // ---------- animations ----------
  const instantSpring = { overshootClamping: true, stiffness: 100000, damping: 100000, mass: 0.01 };
  const patchAnimations = () => {
    const A = RN.Animated;
    if (A && A.timing) {
      unpatches.push(
        patcher.before("timing", A, (args) => {
          if (cfg.noAnimations) args[1] = Object.assign({}, args[1], { duration: 0, delay: 0 });
        })
      );
    }
    if (A && A.spring) {
      unpatches.push(
        patcher.before("spring", A, (args) => {
          if (cfg.noAnimations) args[1] = Object.assign({}, args[1], instantSpring);
        })
      );
    }
    if (RN.LayoutAnimation && RN.LayoutAnimation.configureNext) {
      unpatches.push(
        patcher.instead("configureNext", RN.LayoutAnimation, (args, orig) => {
          if (cfg.noAnimations) return;
          return orig(...args);
        })
      );
    }
    const RA = metro.findByProps("withTiming", "withSpring");
    if (RA && RA.withTiming) {
      unpatches.push(
        patcher.before("withTiming", RA, (args) => {
          if (cfg.noAnimations) args[1] = Object.assign({}, args[1], { duration: 0 });
        })
      );
    }
    if (RA && RA.withSpring) {
      unpatches.push(
        patcher.before("withSpring", RA, (args) => {
          if (cfg.noAnimations) args[1] = Object.assign({}, args[1], instantSpring);
        })
      );
    }
  };

  // ---------- settings ----------
  const Settings = () => {
    vstorage.useProxy(storage);
    const [msg, setMsg] = React.useState("");
    const Forms = ui.components && ui.components.Forms;
    const { ScrollView, Text, TextInput } = RN;
    if (!Forms || !Forms.FormSwitchRow) {
      return React.createElement(Text, { style: { color: "#fff", padding: 16 } }, "Settings UI unavailable on this build.");
    }
    const sw = (key, label, sub) =>
      React.createElement(Forms.FormSwitchRow, {
        key,
        label,
        subLabel: sub,
        value: !!storage[key],
        onValueChange: (v) => {
          storage[key] = v;
          syncCfg();
        },
      });
    const input = (key, placeholder, multiline) =>
      React.createElement(TextInput, {
        key: "in-" + key,
        value: storage[key] || "",
        multiline: !!multiline,
        autoCapitalize: "none",
        autoCorrect: false,
        placeholder,
        placeholderTextColor: "#888",
        onChangeText: (v) => {
          storage[key] = v;
          syncCfg();
        },
        style: { color: "#fff", padding: 14, fontSize: 13, minHeight: multiline ? 90 : 40 },
      });
    const clip = metro.findByProps("setString");
    return React.createElement(
      ScrollView,
      null,
      React.createElement(
        Forms.FormSection,
        { title: "Look", titleStyleType: "no_border" },
        sw("blocky", "Blocky everything", "Square pfps, icons, status dots and buttons. Applies as screens redraw."),
        sw("noAnimations", "Remove animations", "Instant transitions where Discord allows it. Some built-in screen slides can't be touched."),
        React.createElement(Forms.FormRow, {
          label: "Reload Discord",
          subLabel: "Redraws every screen so blocky applies everywhere right away.",
          onPress: () => {
            try {
              const NM = RN.NativeModules;
              if (NM && NM.BundleUpdaterManager && NM.BundleUpdaterManager.reload) NM.BundleUpdaterManager.reload();
              else if (RN.DevSettings && RN.DevSettings.reload) RN.DevSettings.reload();
              else setMsg("Reload isn't available, close Discord from recents and reopen it.");
            } catch (e) {
              setMsg("Reload failed, close Discord from recents and reopen it.");
            }
          },
        })
      ),
      React.createElement(
        Forms.FormSection,
        { title: "Layout rules" },
        React.createElement(Forms.FormText, { style: { padding: 14, opacity: 0.6 } },
          'JSON: component name to style. Example: {"SomeComponent": {"flexDirection": "row-reverse", "bottom": null}}. Use null to unset a value. ' + rulesStatus),
        input("rules", '{"ComponentName": {"flexDirection": "row-reverse"}}', true)
      ),
      React.createElement(
        Forms.FormSection,
        { title: "Layout map recorder" },
        sw("dumpOn", "Record layout map", "Turn on, then open Home, tabs, a DM and a call so screens redraw. Then copy."),
        input("dumpFilter", "Optional keyword filter, e.g. Guild", false),
        React.createElement(Forms.FormRow, {
          label: "Copy map",
          subLabel: msg || "Lines: parent {style} -> child components. Paste it to Claude.",
          onPress: () => {
            try {
              const text = Array.from(map.keys()).join("\n");
              if (!text) return setMsg("Nothing recorded yet");
              clip.setString(text);
              setMsg("Copied " + map.size + " lines");
            } catch (e) {
              setMsg("Copy failed");
            }
          },
        }),
        React.createElement(Forms.FormRow, {
          label: "Clear map",
          onPress: () => {
            map.clear();
            setMsg("Cleared");
          },
        })
      )
    );
  };

  return {
    onLoad() {
      const d = { blocky: true, noAnimations: true, rules: "", dumpOn: false, dumpFilter: "" };
      for (const k in d) if (storage[k] === undefined) storage[k] = d[k];
      syncCfg();
      safe(patchJsx);
      safe(patchAnimations);
    },
    onUnload() {
      unpatches.forEach((u) => safe(u));
      unpatches.length = 0;
      map.clear();
    },
    settings: Settings,
  };
})()
