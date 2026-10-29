using UnityEngine;

/// <summary>
/// Durable Hertz Studio provenance on placed/imported model roots.
/// Stores only stable identifiers — never secrets or unrestricted paths for the browser.
/// </summary>
[DisallowMultipleComponent]
public sealed class HertzStudioAssetProvenance : MonoBehaviour
{
    [SerializeField] private string assetId;
    [SerializeField] private string sourceAssetGuid;
    [SerializeField] private string prefabAssetPath;

    public string AssetId => assetId;
    public string SourceAssetGuid => sourceAssetGuid;
    public string PrefabAssetPath => prefabAssetPath;

    public void SetProvenance(string nextAssetId, string nextSourceGuid = null, string nextPrefabPath = null)
    {
        assetId = string.IsNullOrWhiteSpace(nextAssetId) ? null : nextAssetId.Trim();
        sourceAssetGuid = string.IsNullOrWhiteSpace(nextSourceGuid) ? null : nextSourceGuid.Trim();
        prefabAssetPath = string.IsNullOrWhiteSpace(nextPrefabPath) ? null : nextPrefabPath.Trim();
    }

    public static HertzStudioAssetProvenance EnsureOn(GameObject root, string nextAssetId, string nextSourceGuid = null, string nextPrefabPath = null)
    {
        if (root == null || string.IsNullOrWhiteSpace(nextAssetId))
        {
            return null;
        }

        var existing = root.GetComponent<HertzStudioAssetProvenance>();
        if (existing == null)
        {
            existing = root.AddComponent<HertzStudioAssetProvenance>();
        }

        existing.SetProvenance(nextAssetId, nextSourceGuid, nextPrefabPath);
        return existing;
    }

    public static string FindAssetIdInHierarchy(GameObject go)
    {
        if (go == null)
        {
            return null;
        }

        var prov = go.GetComponentInParent<HertzStudioAssetProvenance>(true);
        return prov != null && !string.IsNullOrWhiteSpace(prov.AssetId) ? prov.AssetId : null;
    }
}
