import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { api } from "./api.js";
import { applyDurableMilestoneGates } from "./lib/milestoneStatus.js";
import Shell from "./layout/Shell.jsx";
import { StudioTargetSceneProvider } from "./context/StudioTargetSceneContext.jsx";
import Login from "./pages/Login.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Connections from "./pages/Connections.jsx";
import Deploy from "./pages/Deploy.jsx";
import Milestones from "./pages/Milestones.jsx";

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [gatesTick, setGatesTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api("/api/auth/me")
      .then((data) => {
        if (!cancelled) setUser(data);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;
    async function loadGates() {
      try {
        const payload = await api("/api/milestones");
        if (cancelled) return;
        applyDurableMilestoneGates(payload);
        setGatesTick((n) => n + 1);
      } catch {
        /* keep baked-in defaults until API available */
      }
    }
    loadGates();
    const timer = setInterval(loadGates, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [user]);

  if (loading) {
    return (
      <div className="studio-stage grid min-h-screen place-items-center">
        <div className="studio-noise" />
        <div className="relative z-[1] glass-pill text-muted-foreground">Loading HERTZ Studio…</div>
      </div>
    );
  }

  if (!user) {
    return <Login onLogin={setUser} />;
  }

  return (
    <StudioTargetSceneProvider>
      <Shell user={user} onLogout={() => setUser(null)}>
        <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/milestones" element={<Milestones />} />
        <Route path="/connections" element={<Connections />} />
        <Route path="/deploy" element={<Deploy />} />
        <Route
          path="/level-editor"
          element={
            <LazyLevelEditor />
          }
        />
        <Route path="/characters" element={<LazyCharacters />} />
        <Route path="/weapons" element={<LazyWeapons />} />
        <Route path="/assets" element={<LazyAssetLibrary />} />
        <Route path="/assets/:id/view" element={<LazyAssetDetail mode="library" />} />
        <Route path="/find" element={<LazyFindAssets />} />
        <Route path="/find-assets/kenney/:id" element={<LazyAssetDetail mode="kenney" />} />
        <Route path="/find-assets/sketchfab/:uid" element={<LazyAssetDetail mode="sketchfab" />} />
        <Route path="/sound" element={<LazySound />} />
        <Route path="/materials" element={<LazyMaterials />} />
        <Route path="/animation" element={<LazyAnimation />} />
        <Route path="/analytics" element={<LazyAnalytics />} />
        <Route path="/performance" element={<LazyPerformance />} />
        <Route path="/snapshots" element={<LazySnapshots />} />
        <Route path="/encounters" element={<LazyEncounters />} />
        <Route path="/avatar-previews" element={<LazyAvatarPreviews />} />
        <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Shell>
    </StudioTargetSceneProvider>
  );
}

function LazyLevelEditor() {
  const [Comp, setComp] = useState(null);
  useEffect(() => {
    import("./pages/LevelEditor.jsx").then((m) => setComp(() => m.default));
  }, []);
  if (!Comp) {
    return (
      <div className="glass-pill w-fit text-muted-foreground">Loading level editor module…</div>
    );
  }
  return <Comp />;
}

function LazyAssetLibrary() {
  const [Comp, setComp] = useState(null);
  useEffect(() => {
    import("./pages/AssetLibrary.jsx").then((m) => setComp(() => m.default));
  }, []);
  if (!Comp) {
    return <div className="glass-pill w-fit text-muted-foreground">Loading asset library…</div>;
  }
  return <Comp />;
}

function LazyFindAssets() {
  const [Comp, setComp] = useState(null);
  useEffect(() => {
    import("./pages/FindAssets.jsx").then((m) => setComp(() => m.default));
  }, []);
  if (!Comp) {
    return <div className="glass-pill w-fit text-muted-foreground">Loading find assets…</div>;
  }
  return <Comp />;
}

function LazyAssetDetail({ mode }) {
  const [Comp, setComp] = useState(null);
  useEffect(() => {
    import("./pages/AssetDetail.jsx").then((m) => setComp(() => m.default));
  }, []);
  if (!Comp) {
    return <div className="glass-pill w-fit text-muted-foreground">Loading asset details…</div>;
  }
  return <Comp mode={mode} />;
}

function LazyCharacters() {
  const [Comp, setComp] = useState(null);
  useEffect(() => {
    import("./pages/Characters.jsx").then((m) => setComp(() => m.default));
  }, []);
  if (!Comp) {
    return <div className="glass-pill w-fit text-muted-foreground">Loading characters…</div>;
  }
  return <Comp />;
}

function LazyAnalytics() {
  const [Comp, setComp] = useState(null);
  useEffect(() => {
    import("./pages/Analytics.jsx").then((m) => setComp(() => m.default));
  }, []);
  if (!Comp) {
    return <div className="glass-pill w-fit text-muted-foreground">Loading analytics…</div>;
  }
  return <Comp />;
}

function LazyWeapons() {
  const [Comp, setComp] = useState(null);
  useEffect(() => {
    import("./pages/Weapons.jsx").then((m) => setComp(() => m.default));
  }, []);
  if (!Comp) {
    return <div className="glass-pill w-fit text-muted-foreground">Loading weapons…</div>;
  }
  return <Comp />;
}

function LazySound() {
  const [Comp, setComp] = useState(null);
  useEffect(() => {
    import("./pages/Sound.jsx").then((m) => setComp(() => m.default));
  }, []);
  if (!Comp) {
    return <div className="glass-pill w-fit text-muted-foreground">Loading sound…</div>;
  }
  return <Comp />;
}

function LazyMaterials() {
  const [Comp, setComp] = useState(null);
  useEffect(() => {
    import("./pages/Materials.jsx").then((m) => setComp(() => m.default));
  }, []);
  if (!Comp) {
    return <div className="glass-pill w-fit text-muted-foreground">Loading materials…</div>;
  }
  return <Comp />;
}

function LazyAnimation() {
  const [Comp, setComp] = useState(null);
  useEffect(() => {
    import("./pages/Animation.jsx").then((m) => setComp(() => m.default));
  }, []);
  if (!Comp) {
    return <div className="glass-pill w-fit text-muted-foreground">Loading animation…</div>;
  }
  return <Comp />;
}

function LazyPerformance() {
  const [Comp, setComp] = useState(null);
  useEffect(() => {
    import("./pages/Performance.jsx").then((m) => setComp(() => m.default));
  }, []);
  if (!Comp) {
    return <div className="glass-pill w-fit text-muted-foreground">Loading performance…</div>;
  }
  return <Comp />;
}

function LazySnapshots() {
  const [Comp, setComp] = useState(null);
  useEffect(() => {
    import("./pages/Snapshots.jsx").then((m) => setComp(() => m.default));
  }, []);
  if (!Comp) {
    return <div className="glass-pill w-fit text-muted-foreground">Loading snapshots…</div>;
  }
  return <Comp />;
}

function LazyEncounters() {
  const [Comp, setComp] = useState(null);
  useEffect(() => {
    import("./pages/Encounters.jsx").then((m) => setComp(() => m.default));
  }, []);
  if (!Comp) {
    return <div className="glass-pill w-fit text-muted-foreground">Loading encounters…</div>;
  }
  return <Comp />;
}

function LazyAvatarPreviews() {
  const [Comp, setComp] = useState(null);
  useEffect(() => {
    import("./pages/AvatarPreviews.jsx").then((m) => setComp(() => m.default));
  }, []);
  if (!Comp) {
    return <div className="glass-pill w-fit text-muted-foreground">Loading avatar previews…</div>;
  }
  return <Comp />;
}
