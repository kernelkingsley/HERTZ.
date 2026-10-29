import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "../api.js";

const StudioTargetSceneContext = createContext(null);

const UNAVAILABLE_TARGET_SCENE_CONTEXT = Object.freeze({
  scenes: [],
  targetScene: null,
  loading: false,
  saving: false,
  error: "",
  refresh: async () => ({ scenes: [], target: null }),
  selectScene: async () => null,
});

export function StudioTargetSceneProvider({ children }) {
  const [scenes, setScenes] = useState([]);
  const [targetScene, setTargetScene] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setError("");
    try {
      const response = await api("/api/unity/scenes");
      setScenes(response.scenes || []);
      setTargetScene(response.target || null);
      return response;
    } catch (err) {
      setError(String(err.message || err));
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const selectScene = useCallback(
    async (sceneGuid) => {
      const scene = scenes.find((candidate) => candidate.guid === sceneGuid);
      setSaving(true);
      setError("");
      try {
        const response = await api("/api/studio/target-scene", {
          method: "PUT",
          body: JSON.stringify(scene ? { scenePath: scene.path, sceneGuid: scene.guid } : {}),
        });
        setTargetScene(response.target || null);
        return response.target || null;
      } catch (err) {
        setError(String(err.message || err));
        throw err;
      } finally {
        setSaving(false);
      }
    },
    [scenes],
  );

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  const value = useMemo(
    () => ({ scenes, targetScene, loading, saving, error, refresh, selectScene }),
    [scenes, targetScene, loading, saving, error, refresh, selectScene],
  );

  return <StudioTargetSceneContext.Provider value={value}>{children}</StudioTargetSceneContext.Provider>;
}

export function useStudioTargetScene() {
  return useContext(StudioTargetSceneContext) || UNAVAILABLE_TARGET_SCENE_CONTEXT;
}