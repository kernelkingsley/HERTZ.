import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const commandsSource = fs.readFileSync(
  path.join(repoRoot, "Assets/Editor/HertzStudio/HertzStudioWeaponCommands.cs"),
  "utf8",
);
const bridgeSource = fs.readFileSync(
  path.join(repoRoot, "Assets/Editor/HertzStudio/HertzStudioHttpBridge.cs"),
  "utf8",
);

test("weapon deploy returns a persistent Unity scene-object identity", () => {
  assert.match(
    commandsSource,
    /result\.ManagedObjectId\s*=\s*managedRoot\s*!=\s*null[\s\S]*?GlobalObjectId\.GetGlobalObjectIdSlow\(managedRoot\)\.ToString\(\)/,
  );
  assert.doesNotMatch(
    commandsSource,
    /result\.ManagedObjectId\s*=\s*managedRoot\s*!=\s*null[\s\S]{0,240}?GetInstanceID\(\)/,
  );
});

test("weapon deploy response keeps definition asset GUID separate from managed object ID", () => {
  assert.match(
    bridgeSource,
    /\\"assetGuid\\":.*Quote\(deploy\.AssetGuid\s*\?\?\s*""\)/,
  );
  assert.doesNotMatch(
    bridgeSource,
    /\\"assetGuid\\":.*Quote\(deploy\.ManagedObjectId/,
  );
});
test("weapon deploy accepts any explicitly selected Assets scene, including SampleScene", () => {
  const deployMethod = commandsSource.slice(
    commandsSource.indexOf("internal static DeployResult DeployToScene("),
    commandsSource.indexOf("private static void EnsureFolder("),
  );
  assert.ok(deployMethod.length > 0, "DeployToScene source must be present");
  assert.doesNotMatch(deployMethod, /Refusing to deploy into SampleScene/);
  assert.doesNotMatch(deployMethod, /scenePath\.IndexOf\("SampleScene"/);
  assert.doesNotMatch(deployMethod, /Use Assets\/Scenes\/HertzWeaponTest\.unity/);
  assert.match(deployMethod, /IsProtectedHierarchy\(runtime\.gameObject\)/);
});