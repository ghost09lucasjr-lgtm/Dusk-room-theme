(() => {
  const { patcher, metro, plugin, storage: vstorage, ui } = vendetta;
  const storage = plugin.storage;
  const { React, ReactNative: RN } = metro.common;
  const el = React.createElement;
  const { View, Text, Pressable, ScrollView, TextInput } = RN;

  const DEFAULTS = {
    blocky: true,
    noAnimations: true,
    splitCall: false,
    splitRatio: 45,
    splitComponent: "ChannelRTCParticipants",
    serverBarBottom: false,
    serverBarSize: 64,
    serverBarOffset: 0,
    serverBarNames: "GuildsBar,GuildsList,GuildsNavigator",
    userBarTop: false,
    userBarNames: "",
  };

  const diag = {};
  const unpatches = [];
  const timers = [];
  const note = (k, v) => {
    diag[k] = v;
  };
  const safe = (label, fn) => {
    try {
      fn();
    } catch (e) {
      note(label, "error: " + ((e && e.message) || e));
    }
  };

  // ---------- blocky ----------
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

  // ---------- helpers to find components ----------
  const findMod = (name) => {
    try {
      return metro.findByName(name, false) || metro.findByDisplayName(name, false) || null;
    } catch (e) {
      return null;
    }
  };

  const typesFor = (names) => {
    const set = new Set();
    String(names || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((n) => {
        const m = findMod(n);
        if (!m) return;
        set.add(m);
        const d = m.default;
        if (d) {
          set.add(d);
          if (d.type) set.add(d.type);
          if (d.render) set.add(d.render);
        }
      });
    return set;
  };

  const lazyTypes = (getNames) => {
    let set = new Set();
    let last = 0;
    let sig = "";
    return () => {
      const names = getNames();
      const now = Date.now();
      if ((!set.size || names !== sig) && now - last > 2500) {
        last = now;
        sig = names;
        set = typesFor(names);
      }
      return set;
    };
  };

  const getServerTypes = lazyTypes(() => storage.serverBarNames || "");
  const getUserTypes = lazyTypes(() => storage.userBarNames || "");
  const getFooterTypes = lazyTypes(() => "GuildsBarFooterWrapper");

  // ---------- element handler (blocky, animations, layout) ----------
  const NO_ANIM = { animation: "none", animationEnabled: false, animationDuration: 0 };
  const noAnim = (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.assign({}, o, NO_ANIM) : o);

  const isServerBar = (type, props) => {
    const t = getServerTypes();
    if (t.size && type && t.has(type)) return true;
    const f = getFooterTypes();
    if (f.size && props) {
      const c = props.ListFooterComponent;
      if (c && (f.has(c) || (c.type && f.has(c.type)))) return true;
    }
    return false;
  };

  const onElement = (args) => {
    const props = args[1];
    if (!props || typeof props !== "object") return;
    let next = props;

    if (storage.blocky && props.style) {
      const s = squareStyle(props.style);
      if (s !== props.style) next = Object.assign({}, next, { style: s });
    }

    if (storage.noAnimations && (props.screenOptions || props.options)) {
      next = Object.assign({}, next);
      if (props.screenOptions) next.screenOptions = noAnim(props.screenOptions);
      if (props.options) next.options = noAnim(props.options);
    }

    if (storage.serverBarBottom && isServerBar(args[0], props)) {
      diag.serverBarMatches = (diag.serverBarMatches || 0) + 1;
      next = Object.assign({}, next, {
        horizontal: true,
        style: [
          next.style,
          {
            position: "absolute",
            left: 0,
            right: 0,
            bottom: storage.serverBarOffset || 0,
            top: undefined,
            width: "100%",
            height: storage.serverBarSize || 64,
            flexDirection: "row",
          },
        ],
      });
    }

    if (storage.userBarTop && args[0]) {
      const u = getUserTypes();
      if (u.size && u.has(args[0])) {
        diag.userBarMatches = (diag.userBarMatches || 0) + 1;
        next = Object.assign({}, next, {
          style: [
            next.style,
            {
              position: "absolute",
              top: ((RN.StatusBar && RN.StatusBar.currentHeight) || 24) + 4,
              right: 8,
              left: undefined,
              bottom: undefined,
              width: 240,
            },
          ],
        });
      }
    }

    if (next !== props) args[1] = next;
  };

  // ---------- animations ----------
  const patchAnimations = () => {
    const A = RN.Animated;
    const instant = { overshootClamping: true, stiffness: 100000, damping: 100000, mass: 0.01 };
    if (A && A.timing)
      unpatches.push(
        patcher.before("timing", A, (a) => {
          if (storage.noAnimations) a[1] = Object.assign({}, a[1], { duration: 0, delay: 0 });
        })
      );
    if (A && A.spring)
      unpatches.push(
        patcher.before("spring", A, (a) => {
          if (storage.noAnimations) a[1] = Object.assign({}, a[1], instant);
        })
      );
    if (RN.LayoutAnimation && RN.LayoutAnimation.configureNext)
      unpatches.push(
        patcher.instead("configureNext", RN.LayoutAnimation, (a, orig) => {
          if (!storage.noAnimations) return orig(...a);
        })
      );
    const RA = metro.findByProps("withTiming", "withSpring");
    if (RA && RA.withTiming)
      unpatches.push(
        patcher.before("withTiming", RA, (a) => {
          if (storage.noAnimations) a[1] = Object.assign({}, a[1], { duration: 0 });
        })
      );
    if (RA && RA.withSpring)
      unpatches.push(
        patcher.before("withSpring", RA, (a) => {
          if (storage.noAnimations) a[1] = Object.assign({}, a[1], instant);
        })
      );
  };

  // ---------- split-screen call ----------
  class Boundary extends React.Component {
    constructor(p) {
      super(p);
      this.state = { failed: false };
    }
    static getDerivedStateFromError() {
      return { failed: true };
    }
    componentDidCatch(e) {
      diag.splitError = String((e && e.message) || e);
    }
    render() {
      return this.state.failed ? this.props.fallback || null : this.props.children;
    }
  }

  const selectedStore = () => {
    try {
      return metro.findByProps("getVoiceChannelId", "getChannelId") || metro.findByStoreName("SelectedChannelStore");
    } catch (e) {
      return null;
    }
  };
  let store = null;

  const useVoiceInfo = () => {
    const [, force] = React.useReducer((x) => x + 1, 0);
    if (!store) store = selectedStore();
    React.useEffect(() => {
      if (!store || !store.addChangeListener) return undefined;
      store.addChangeListener(force);
      return () => store.removeChangeListener(force);
    }, []);
    return {
      vc: store && store.getVoiceChannelId ? store.getVoiceChannelId() : null,
      cur: store && store.getChannelId ? store.getChannelId() : null,
    };
  };

  const openFull = (channelId) => {
    try {
      const m = metro.findByProps("openChannelCallModalForChannelId") || metro.findByProps("openChannelCallModal");
      const f = m && (m.openChannelCallModalForChannelId || m.openChannelCallModal);
      if (f) f(channelId);
      else note("fullscreen", "open function not found");
    } catch (e) {
      note("fullscreen", "failed: " + e);
    }
  };

  const closeCallScreen = () => {
    try {
      const m = metro.findByProps("dismissVoiceChannelScreens");
      if (m) m.dismissVoiceChannelScreens();
      else note("split button", "dismiss function not found");
    } catch (e) {
      note("split button", "failed: " + e);
    }
  };

  const BTN = {
    position: "absolute",
    top: 8,
    right: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "#ff6f91",
    borderRadius: 0,
  };
  const BTN_TEXT = { color: "#0b0a1f", fontWeight: "700", fontSize: 12 };

  const splitComp = () => {
    const m = findMod(storage.splitComponent || "ChannelRTCParticipants");
    return m ? (m.default !== undefined ? m.default : m) : null;
  };

  const Strip = (p) => {
    const Comp = splitComp();
    const h = Math.round((RN.Dimensions.get("window").height * (storage.splitRatio || 45)) / 100);
    const label = el(Text, { style: { color: "#f1e9ff", padding: 16 } }, "Call is active");
    return el(
      View,
      { style: { height: h, backgroundColor: "#0b0a1f", overflow: "hidden" } },
      Comp ? el(Boundary, { fallback: label }, el(Comp, { channelId: p.channelId })) : label,
      el(Pressable, { onPress: () => openFull(p.channelId), style: BTN }, el(Text, { style: BTN_TEXT }, "FULL SCREEN"))
    );
  };

  const SplitWrapper = (p) => {
    const info = useVoiceInfo();
    if (!storage.splitCall || !info.vc || info.vc !== info.cur) return p.inner;
    return el(View, { style: { flex: 1 } }, el(Strip, { channelId: info.vc }), el(View, { style: { flex: 1 } }, p.inner));
  };

  const CallModalButton = (p) => {
    if (!storage.splitCall) return p.inner;
    return el(
      View,
      { style: { flex: 1 } },
      p.inner,
      el(Pressable, { onPress: closeCallScreen, style: [BTN, { top: 56 }] }, el(Text, { style: BTN_TEXT }, "SPLIT"))
    );
  };

  const patchComponent = (name, wrap) => {
    const mod = findMod(name);
    if (!mod) return false;
    const d = mod.default !== undefined ? mod.default : mod;
    let parent = null;
    let key = null;
    if (typeof mod.default === "function") {
      parent = mod;
      key = "default";
    } else if (d && typeof d === "object" && typeof d.type === "function") {
      parent = d;
      key = "type";
    } else if (d && typeof d === "object" && typeof d.render === "function") {
      parent = d;
      key = "render";
    }
    if (!parent) {
      note(name, "found, can't patch");
      return true;
    }
    unpatches.push(
      patcher.after(key, parent, (a, ret) => {
        try {
          return wrap(ret);
        } catch (e) {
          return ret;
        }
      })
    );
    note(name, "patched");
    return true;
  };

  const patchWithRetry = (name, wrap, tries) => {
    if (patchComponent(name, wrap)) return;
    note(name, "not found yet");
    if (tries <= 0) {
      note(name, "not found");
      return;
    }
    timers.push(setTimeout(() => safe(name, () => patchWithRetry(name, wrap, tries - 1)), 4000));
  };

  // ---------- settings UI ----------
  const Settings = () => {
    vstorage.useProxy(storage);
    const [msg, setMsg] = React.useState("");
    const Forms = ui.components && ui.components.Forms;
    if (!Forms || !Forms.FormSwitchRow || !Forms.FormRow) {
      return el(Text, { style: { color: "#fff", padding: 16 } }, "Settings UI unavailable on this build.");
    }
    const sw = (key, label, sub) =>
      el(Forms.FormSwitchRow, {
        key,
        label,
        subLabel: sub,
        value: !!storage[key],
        onValueChange: (v) => {
          storage[key] = v;
        },
      });
    const cycle = (key, label, values, unit) =>
      el(Forms.FormRow, {
        key,
        label: label + ": " + storage[key] + unit,
        subLabel: "Tap to change",
        onPress: () => {
          const i = values.indexOf(storage[key]);
          storage[key] = values[(i + 1) % values.length];
        },
      });
    const input = (key, label, ph) => [
      el(Text, { key: key + "l", style: { color: "#b9aee0", paddingHorizontal: 16, paddingTop: 12, fontSize: 12 } }, label),
      el(TextInput, {
        key,
        value: String(storage[key] || ""),
        placeholder: ph,
        placeholderTextColor: "#777",
        autoCapitalize: "none",
        autoCorrect: false,
        onChangeText: (v) => {
          storage[key] = v;
        },
        style: { color: "#fff", paddingHorizontal: 16, paddingVertical: 8 },
      }),
    ];
    const diagText = Object.keys(diag)
      .map((k) => k + ": " + diag[k])
      .join("\n");
    const clip = metro.findByProps("setString");

    return el(
      ScrollView,
      null,
      el(
        Forms.FormSection,
        { title: "Look", titleStyleType: "no_border" },
        sw("blocky", "Blocky everything", "Square pfps, icons, status dots and buttons."),
        sw("noAnimations", "Remove animations", "Instant transitions where Discord allows it.")
      ),
      el(
        Forms.FormSection,
        { title: "Split-screen call (experimental)" },
        sw("splitCall", "Split call and chat", "In a DM call, the chat shows the call on top. FULL SCREEN opens the call; SPLIT on the call screen returns."),
        cycle("splitRatio", "Call height", [35, 45, 50, 60], "% of screen"),
        ...input("splitComponent", "Call component name", "ChannelRTCParticipants")
      ),
      el(
        Forms.FormSection,
        { title: "Layout (experimental, restart after changing)" },
        sw("serverBarBottom", "Server bar at the bottom", "Turns the server list horizontal and pins it to the bottom."),
        cycle("serverBarSize", "Server bar height", [52, 60, 64, 72], "px"),
        cycle("serverBarOffset", "Lift server bar", [0, 40, 72, 90], "px"),
        ...input("serverBarNames", "Server bar component names (comma separated)", "GuildsBar,GuildsList"),
        sw("userBarTop", "User bar at the top right", "Needs the user bar's component name below."),
        ...input("userBarNames", "User bar component names", "name from the inspector")
      ),
      el(
        Forms.FormSection,
        { title: "Diagnostics" },
        el(Text, { selectable: true, style: { color: "#fff", padding: 16, fontSize: 12 } }, diagText || "Nothing yet."),
        el(Forms.FormRow, {
          label: "Copy diagnostics",
          subLabel: msg,
          onPress: () => {
            try {
              clip.setString(diagText);
              setMsg("Copied");
            } catch (e) {
              setMsg("Copy failed");
            }
          },
        }),
        el(Forms.FormRow, {
          label: "Reset all settings",
          onPress: () => {
            Object.keys(DEFAULTS).forEach((k) => {
              storage[k] = DEFAULTS[k];
            });
            setMsg("Reset");
          },
        })
      )
    );
  };

  return {
    onLoad() {
      Object.keys(DEFAULTS).forEach((k) => {
        if (storage[k] === undefined) storage[k] = DEFAULTS[k];
      });
      safe("element patch", () => {
        const runtime = metro.findByProps("jsx", "jsxs", "Fragment");
        if (runtime) {
          unpatches.push(patcher.before("jsx", runtime, onElement));
          if (runtime.jsxs) unpatches.push(patcher.before("jsxs", runtime, onElement));
        }
        const R = metro.findByProps("createElement", "useState");
        if (R) unpatches.push(patcher.before("createElement", R, onElement));
        note("element patch", runtime ? "jsx runtime patched" : "createElement patched");
      });
      safe("animations", patchAnimations);
      safe("chat screen", () =>
        patchWithRetry("ChatViewWrapperBase", (ret) => el(SplitWrapper, { inner: ret }), 3)
      );
      safe("call screen", () =>
        patchWithRetry("ChannelCallModal", (ret) => el(CallModalButton, { inner: ret }), 3)
      );
    },
    onUnload() {
      timers.forEach((t) => clearTimeout(t));
      timers.length = 0;
      unpatches.forEach((u) => safe("unpatch", u));
      unpatches.length = 0;
    },
    settings: Settings,
  };
})()
