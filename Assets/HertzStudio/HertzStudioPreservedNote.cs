using UnityEngine;

/// <summary>
/// Project-owned component migrated across floor/wall replacement.
/// Used by W03 proofs and as the contract for serialized Studio settings on surfaces.
/// </summary>
[DisallowMultipleComponent]
public sealed class HertzStudioPreservedNote : MonoBehaviour
{
    [SerializeField] private string note = "";
    [SerializeField] private int counter;
    [SerializeField] private bool flag;

    public string Note => note;
    public int Counter => counter;
    public bool Flag => flag;

    public void SetValues(string nextNote, int nextCounter, bool nextFlag)
    {
        note = nextNote ?? "";
        counter = nextCounter;
        flag = nextFlag;
    }
}
