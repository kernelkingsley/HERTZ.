import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeUnityBindingsIntoDraft, markAssignmentOpsApplied } from "./store.mjs";

describe("binding merge safety", () => {
  it("never merges binding into object removed after queue", () => {
    const draft = {
      objects: [{ objectId: "a", removed: true, assetId: "asset-1" }],
    };
    mergeUnityBindingsIntoDraft(
      draft,
      [{ draftObjectId: "a", unityObjectId: "gid-1" }],
      [{ op: "instantiate_model", draftObjectId: "a", assetId: "asset-1" }],
    );
    assert.equal(draft.objects[0].unityObjectId, undefined);
    assert.equal(draft.objects[0].bindingStale, true);
    assert.equal(draft.bindingResyncRequired, true);
  });

  it("never binds after asset identity changed", () => {
    const draft = {
      objects: [{ objectId: "a", assetId: "asset-NEW" }],
    };
    mergeUnityBindingsIntoDraft(
      draft,
      [{ draftObjectId: "a", unityObjectId: "gid-1" }],
      [{ op: "instantiate_model", draftObjectId: "a", assetId: "asset-OLD" }],
    );
    assert.equal(draft.objects[0].unityObjectId, undefined);
    assert.match(draft.objects[0].bindingError, /asset changed/i);
  });

  it("never rebinds conflicting unity ids", () => {
    const draft = {
      objects: [{ objectId: "a", assetId: "asset-1", unityObjectId: "gid-keep" }],
    };
    mergeUnityBindingsIntoDraft(
      draft,
      [{ draftObjectId: "a", unityObjectId: "gid-new" }],
      [{ op: "instantiate_model", draftObjectId: "a", assetId: "asset-1" }],
    );
    assert.equal(draft.objects[0].unityObjectId, "gid-keep");
    assert.equal(draft.objects[0].bindingStale, true);
  });

  it("marks assignment ops applied so they are not re-queued", () => {
    const draft = {
      objects: [{ objectId: "op-1", source: "library_drop", assignmentApplied: false }],
    };
    markAssignmentOpsApplied(draft, [{ op: "assign_material", draftObjectId: "op-1" }]);
    assert.equal(draft.objects[0].assignmentApplied, true);
  });
});
