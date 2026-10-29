using UnityEngine;

/// <summary>
/// Explicit HERTZ Studio surface classification for floor/wall replace and walkability.
/// Authoritative for Studio export — not derived from object or mesh names.
/// </summary>
[DisallowMultipleComponent]
public sealed class HertzStudioSurfaceKind : MonoBehaviour
{
    public enum Kind
    {
        None = 0,
        Floor = 1,
        Wall = 2,
    }

    [SerializeField] private Kind kind = Kind.None;

    public Kind SurfaceKind => kind;

    public void SetKind(Kind next)
    {
        kind = next;
    }

    public static HertzStudioSurfaceKind EnsureOn(GameObject go, Kind next = Kind.None)
    {
        if (go == null) return null;
        var existing = go.GetComponent<HertzStudioSurfaceKind>();
        if (existing == null) existing = go.AddComponent<HertzStudioSurfaceKind>();
        existing.SetKind(next);
        return existing;
    }

    public static string ToExportToken(Kind value)
    {
        if (value == Kind.Floor) return "floor";
        if (value == Kind.Wall) return "wall";
        return null;
    }
}
