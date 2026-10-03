(() => {
  const { patcher, metro, plugin, storage: vstorage, ui } = vendetta;
  const storage = plugin.storage;
  const { React, ReactNative: RN } = metro.common;

  // ---------- config (plain object, so hot paths never touch the storage proxy) ----------
  const cfg = { blocky: true, noAnimations: true, rules: {}, hasRules: false, dump: false, dumpRe: null, dumpFilterOn: false };
  const DEFAULT_DUMP_RE = /guild|server|account|usertile|panel|call|drawer|tab|chat|channel|friend|dm|conversation|home|safearea|header|messages/i;
  let rulesStatus = "No rules";

  const flatten = (style) => {
    try {
      return RN.StyleSheet && RN.StyleSheet.flatten ? RN.StyleSheet.flatten(style) : style;
    } catch (e) {
      return null;
    }
  };

  // rules JSON: { "ComponentName": { "$find": "row"|"absolute"|"any", "<style key>": value, ... } }
  const parseRules = (text) => {
    const obj = JSON.parse(text);
    const out = {};
    for (const k in obj) {
      const v = obj[k];
      if (!v || typeof v !== "object") continue;
      const rule = { style: {}, find: null };
      for (const p in v) {
        if (p === "$find") rule.find = String(v[p]);
        else rule.style[p] = v[p] === null ? undefined : v[p];
      }
      out[k] = rule;
    }
    return out;
  };

  const syncCfg = () => {
    cfg.blocky = !!storage.blocky;
    cfg.noAnimations = !!storage.noAnimations;
    cfg.dump = !!storage.dumpOn;
    const f = (storage.dumpFilter || "").trim();
    cfg.dumpFilterOn = !!f;
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
      const flat = flatten(style);
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

  // ---------- "find" rules: restyle the first matching element inside a component's output ----------
  const matchFind = (find, style) => {
    const s = flatten(style);
    if (!s || typeof s !== "object") return false;
    if (find === "absolute") return s.position === "absolute";
    if (find === "row") return s.flexDirection === "row";
    return true;
  };

  const applyDeep = (node, rule, depth) => {
    if (!node || typeof node !== "object" || depth > 8) return node;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const r = applyDeep(node[i], rule, depth + 1);
        if (r !== node[i]) {
          const copy = node.slice();
          copy[i] = r;
          return copy;
        }
      }
      return node;
    }
    const props = node.props;
    if (!props) return node;
    if (props.style && matchFind(rule.find, props.style)) {
      return React.cloneElement(node, { style: [props.style, rule.style] });
    }
    const ch = props.children;
    if (ch && typeof ch === "object") {
      const r = applyDeep(ch, rule, depth + 1);
      if (r !== ch) return React.cloneElement(node, { children: r });
    }
    return node;
  };

  const unwrap = (t) => {
    if (typeof t === "function") {
      if (t.prototype && t.prototype.isReactComponent) return null;
      return { fn: t, ref: false };
    }
    if (t && typeof t === "object") {
      if (typeof t.render === "function") return { fn: t.render, ref: true };
      if (t.type) return unwrap(t.type);
    }
    return null;
  };

  const wrappers = new WeakMap();
  const wrapperFor = (type, rule) => {
    const hit = wrappers.get(type);
    if (hit && hit.rule === rule) return hit.W;
    const u = unwrap(type);
    if (!u || !React.forwardRef) return null;
    const W = React.forwardRef((props, ref) => {
      const out = u.ref ? u.fn(props, ref) : u.fn(props);
      try {
        return applyDeep(out, rule, 0);
      } catch (e) {
        return out;
      }
    });
    W.displayName = nameOfType(type);
    wrappers.set(type, { rule, W });
    return W;
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
        if (rule.find) {
          const W = wrapperFor(args[0], rule);
          if (W) args[0] = W;
        } else {
          style = style ? [style, rule.style] : rule.style;
          changed = true;
        }
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
    const parentName = nameOfType(ret.type) || "?";
    let hit = cfg.dumpFilterOn && cfg.dumpRe.test(parentName);
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
    const line = parentName + styleText(p.style) + " -> " + names.join(", ");
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

  // ---------- presets ----------
  const PRESETS = {
    serverRight: { MainChannelsRedesignInner: { $find: "row", flexDirection: "row-reverse" } },
    userBarTop: { YouBarThemed: { $find: "absolute", top: 48, bottom: null, left: null, right: 8, width: 260 } },
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
        style: { color: "#fff", padding: 14, fontSize: 13, minHeight: multiline ? 120 : 40 },
      });
    const row = (key, label, sub, onPress) => React.createElement(Forms.FormRow, { key, label, subLabel: sub, onPress });
    const addPreset = (obj, name) => {
      let cur = {};
      try {
        cur = JSON.parse(storage.rules || "{}") || {};
      } catch (e) {}
      storage.rules = JSON.stringify(Object.assign({}, cur, obj), null, 1);
      syncCfg();
      setMsg(name + " added. Tap Reload Discord to apply.");
    };
    const reload = () => {
      try {
        const NM = RN.NativeModules;
        if (NM && NM.BundleUpdaterManager && NM.BundleUpdaterManager.reload) NM.BundleUpdaterManager.reload();
        else if (RN.DevSettings && RN.DevSettings.reload) RN.DevSettings.reload();
        else setMsg("Reload isn't available, close Discord from recents and reopen it.");
      } catch (e) {
        setMsg("Reload failed, close Discord from recents and reopen it.");
      }
    };
    const clip = metro.findByProps("setString");
    return React.createElement(
      ScrollView,
      null,
      React.createElement(
        Forms.FormSection,
        { title: "Look", titleStyleType: "no_border" },
        sw("blocky", "Blocky everything", "Square pfps, icons, status dots and buttons."),
        sw("noAnimations", "Remove animations", "Instant transitions where Discord allows it."),
        row("reload", "Reload Discord", msg || "Redraws every screen so changes apply everywhere.", reload)
      ),
      React.createElement(
        Forms.FormSection,
        { title: "Layout presets" },
        row("p1", "Server bar to the right", "Flips the server bar and panel (best guess).", () => addPreset(PRESETS.serverRight, "Server bar preset")),
        row("p2", "User bar to the top right", "Moves the bar under the status bar, compact (best guess).", () => addPreset(PRESETS.userBarTop, "User bar preset")),
        row("p3", "Clear all rules", "Puts everything back.", () => {
          storage.rules = "";
          syncCfg();
          setMsg("Rules cleared. Tap Reload Discord.");
        })
      ),
      React.createElement(
        Forms.FormSection,
        { title: "Layout rules (advanced)" },
        React.createElement(Forms.FormText, { style: { padding: 14, opacity: 0.6 } },
          'JSON: component name to style. "$find" ("row", "absolute", "any") restyles the first matching element inside it. Use null to unset a value. ' + rulesStatus),
        input("rules", '{"ComponentName": {"$find": "row", "flexDirection": "row-reverse"}}', true)
      ),
      React.createElement(
        Forms.FormSection,
        { title: "Layout map recorder" },
        sw("dumpOn", "Record layout map", "Turn on, use the app so screens redraw, then copy."),
        input("dumpFilter", "Optional keyword filter, e.g. YouBar", false),
        row("copy", "Copy map", "Lines: parent {style} -> children. Paste it to Claude.", () => {
          try {
            const text = Array.from(map.keys()).join("\n");
            if (!text) return setMsg("Nothing recorded yet");
            clip.setString(text);
            setMsg("Copied " + map.size + " lines");
          } catch (e) {
            setMsg("Copy failed");
          }
        }),
        row("clear", "Clear map", "", () => {
          map.clear();
          setMsg("Cleared");
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
