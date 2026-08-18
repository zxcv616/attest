// NOT compiled or run against a real Unity Editor — see repo root README
// "Why the fixture isn't 'just there'". Written against documented Unity
// Editor / Input System APIs but unverified by a real compiler. This is the
// first script to validate once Unity is available (Attest → Fixtures →
// Build Platformer Basic) — everything downstream (M1's transaction tests
// against this fixture) depends on it actually working.

using System.IO;
using AttestFixture.Health;
using AttestFixture.HUD;
using AttestFixture.Input;
using AttestFixture.Movement;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.SceneManagement;
using UnityEngine.UI;
using Object = UnityEngine.Object;

namespace AttestFixture.Editor
{
    /// <summary>
    /// Builds the fixture's input actions, prefabs, and scene
    /// PROGRAMMATICALLY via real Editor APIs — never by hand-writing scene
    /// or prefab YAML. Field assignment goes through SerializedObject/
    /// SerializedProperty throughout, the same discipline spec principle 3
    /// requires of Attest itself when it mutates serialized state, even
    /// though this is one-time fixture bootstrap code, not a live Attest
    /// transaction.
    ///
    /// Idempotent: re-running deletes and rebuilds the generated assets.
    /// </summary>
    public static class FixtureBuilder
    {
        private const string PrefabDir = "Assets/Prefabs";
        private const string InputDir = "Assets/Input";
        private const string SceneDir = "Assets/Scenes";
        private const string SpriteDir = "Assets/Sprites";

        [MenuItem("Attest/Fixtures/Build Platformer Basic")]
        public static void Build()
        {
            Directory.CreateDirectory(PrefabDir);
            Directory.CreateDirectory(InputDir);
            Directory.CreateDirectory(SceneDir);
            Directory.CreateDirectory(SpriteDir);

            var inputActions = BuildInputActions();
            var moveRef = BuildMoveActionReference(inputActions);
            var playerPrefab = BuildPlayerPrefab(moveRef);
            var hazardPrefab = BuildHazardPrefab();
            var hudPrefab = BuildHudPrefab();

            BuildLevelScene(playerPrefab, hazardPrefab, hudPrefab);

            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            EditorUtility.DisplayDialog(
                "Attest Fixture",
                "Built PlayerControls.inputactions, Player/Hazard/HUD prefabs, and Level1.unity.",
                "OK");
        }

        private static InputActionAsset BuildInputActions()
        {
            var path = $"{InputDir}/PlayerControls.inputactions";
            if (File.Exists(path))
            {
                // Unconditional, and checked by raw file existence rather
                // than AssetDatabase.LoadAssetAtPath<InputActionAsset>(path)
                // != null: a file left over from a FAILED import (see the
                // ToJson()/ImportAsset fix below) never loads as a valid
                // InputActionAsset, so that check silently skipped cleanup
                // and left a corrupt file + stale .meta behind — exactly
                // what caused the "may be corrupted" re-import failure hit
                // running this for real.
                AssetDatabase.DeleteAsset(path);
            }

            var asset = ScriptableObject.CreateInstance<InputActionAsset>();
            var map = asset.AddActionMap("Player");

            // Move only. No Dash action — that's what Attest's first task
            // adds via input.apply_changes (spec §9 tool surface), and it
            // must do so by editing THIS existing asset, not replacing it
            // (spec §17 demo: "updates the project's existing input asset").
            var move = map.AddAction("Move", InputActionType.Value, expectedControlLayout: "Vector2");
            move.AddCompositeBinding("2DVector")
                .With("Up", "<Keyboard>/w")
                .With("Down", "<Keyboard>/s")
                .With("Left", "<Keyboard>/a")
                .With("Right", "<Keyboard>/d");
            move.AddBinding("<Gamepad>/leftStick");

            // .inputactions files are plain JSON, loaded through a custom
            // ScriptedImporter (InputActionImporter) — NOT Unity's normal
            // ScriptableObject YAML asset serialization. AssetDatabase.CreateAsset()
            // writes the latter, producing a file the importer can't parse
            // ("JSON parse error: Invalid value") — hit running this fixture
            // builder for real. ToJson() + write + ImportAsset is correct.
            var json = asset.ToJson();
            Object.DestroyImmediate(asset);
            File.WriteAllText(path, json);
            AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceUpdate);

            return AssetDatabase.LoadAssetAtPath<InputActionAsset>(path);
        }

        /// <summary>
        /// A standalone .asset file, not a sub-asset embedded in the
        /// .inputactions file. AssetDatabase.AddObjectToAsset() on an asset
        /// imported by a custom ScriptedImporter (Input System's own
        /// InputActionImporter here) isn't supported the way it is for a
        /// plain AssetDatabase.CreateAsset()-created asset — it threw "may
        /// be corrupted" when tried, running this for real. A standalone
        /// InputActionReference asset is what the Input Actions editor
        /// window itself produces when you drag one out, and it sidesteps
        /// the problem entirely.
        /// </summary>
        private static InputActionReference BuildMoveActionReference(InputActionAsset inputActions)
        {
            var path = $"{InputDir}/Move.asset";
            if (File.Exists(path)) AssetDatabase.DeleteAsset(path);

            var move = inputActions.FindActionMap("Player").FindAction("Move");
            var moveRef = InputActionReference.Create(move);
            AssetDatabase.CreateAsset(moveRef, path);
            AssetDatabase.SaveAssets();

            return AssetDatabase.LoadAssetAtPath<InputActionReference>(path);
        }

        private static GameObject BuildPlayerPrefab(InputActionReference moveRef)
        {
            var go = new GameObject("Player");
            var rb = go.AddComponent<Rigidbody2D>();
            rb.gravityScale = 0f; // top-down fixture, not a side-scroller — see Documentation~/README.md

            const float playerSize = 1.2f;
            var col = go.AddComponent<BoxCollider2D>();
            col.size = new Vector2(playerSize, playerSize);

            var sr = go.AddComponent<SpriteRenderer>();
            sr.sprite = PlaceholderSprite("player", Color.cyan, playerSize);

            go.AddComponent<Health.Health>();

            var inputComp = go.AddComponent<InputSystemPlayerInput>();
            SetPrivateRef(inputComp, "moveAction", moveRef);

            var controller = go.AddComponent<PlayerController>();
            SetPrivateRef(controller, "inputSource", inputComp);

            var prefab = PrefabUtility.SaveAsPrefabAsset(go, $"{PrefabDir}/Player.prefab");
            Object.DestroyImmediate(go);
            return prefab;
        }

        private static GameObject BuildHazardPrefab()
        {
            const float hazardSize = 1f;
            var go = new GameObject("Hazard");
            var col = go.AddComponent<BoxCollider2D>();
            col.isTrigger = true;
            col.size = new Vector2(hazardSize, hazardSize);

            var sr = go.AddComponent<SpriteRenderer>();
            sr.sprite = PlaceholderSprite("hazard", Color.red, hazardSize);

            go.AddComponent<AttestFixture.Hazard.Hazard>();

            var prefab = PrefabUtility.SaveAsPrefabAsset(go, $"{PrefabDir}/Hazard.prefab");
            Object.DestroyImmediate(go);
            return prefab;
        }

        private static GameObject BuildHudPrefab()
        {
            var canvasGo = new GameObject("HUD", typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
            canvasGo.GetComponent<Canvas>().renderMode = RenderMode.ScreenSpaceOverlay;

            var textGo = new GameObject("HealthText", typeof(Text));
            textGo.transform.SetParent(canvasGo.transform, false);
            var text = textGo.GetComponent<Text>();
            text.text = "HP: -";
            text.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            text.rectTransform.anchorMin = new Vector2(0f, 1f);
            text.rectTransform.anchorMax = new Vector2(0f, 1f);
            text.rectTransform.anchoredPosition = new Vector2(80, -20);
            text.rectTransform.sizeDelta = new Vector2(160, 30);

            var presenter = canvasGo.AddComponent<HudPresenter>();
            SetPrivateRef(presenter, "healthText", text);
            // "health" is assigned once the Player instance exists in the
            // scene — see BuildLevelScene. A prefab can't reference a
            // scene object, so this one field is necessarily wired later.

            var prefab = PrefabUtility.SaveAsPrefabAsset(canvasGo, $"{PrefabDir}/HUD.prefab");
            Object.DestroyImmediate(canvasGo);
            return prefab;
        }

        private static void BuildLevelScene(GameObject playerPrefab, GameObject hazardPrefab, GameObject hudPrefab)
        {
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            var cameraGo = new GameObject("Main Camera", typeof(Camera));
            cameraGo.tag = "MainCamera";
            var cam = cameraGo.GetComponent<Camera>();
            cam.orthographic = true;
            cam.orthographicSize = 3f; // was 5 — too zoomed out for a ~1-unit player to read as anything
            cameraGo.transform.position = new Vector3(0, 0, -10);

            var player = (GameObject)PrefabUtility.InstantiatePrefab(playerPrefab, scene);
            player.transform.position = Vector3.zero;

            var hazard = (GameObject)PrefabUtility.InstantiatePrefab(hazardPrefab, scene);
            hazard.transform.position = new Vector3(4, 0, 0);

            var hud = (GameObject)PrefabUtility.InstantiatePrefab(hudPrefab, scene);
            var presenter = hud.GetComponent<HudPresenter>();
            SetPrivateRef(presenter, "health", player.GetComponent<Health.Health>());

            if (!EditorSceneManager.SaveScene(scene, $"{SceneDir}/Level1.unity"))
            {
                Debug.LogError("[Attest Fixture] Failed to save Level1.unity");
            }
        }

        /// <summary>
        /// worldSize in Unity units. Writes a real .png asset and imports it
        /// as a Sprite — NOT Sprite.Create() from an in-memory Texture2D.
        /// That in-memory version has no file/GUID identity, so when the
        /// GameObject holding it got saved as a prefab, Unity's serializer
        /// had nothing persistent to point at and silently dropped the
        /// reference: the Sprite field on Sprite Renderer showed "None" —
        /// confirmed running this for real (Inspector screenshot showed
        /// empty Sprite despite the field being set in code). Same category
        /// of bug as the earlier .inputactions issue: anything referenced
        /// from a saved asset has to be a real asset itself, not a
        /// transient runtime object.
        /// </summary>
        private static Sprite PlaceholderSprite(string name, Color color, float worldSize = 1f)
        {
            const int texturePixels = 32;
            var path = $"{SpriteDir}/{name}.png";
            if (File.Exists(path)) AssetDatabase.DeleteAsset(path);

            var tex = new Texture2D(texturePixels, texturePixels);
            var pixels = new Color[texturePixels * texturePixels];
            for (var i = 0; i < pixels.Length; i++) pixels[i] = color;
            tex.SetPixels(pixels);
            tex.Apply();
            var png = tex.EncodeToPNG();
            Object.DestroyImmediate(tex);

            File.WriteAllBytes(path, png);
            AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceUpdate);

            var importer = (TextureImporter)AssetImporter.GetAtPath(path);
            importer.textureType = TextureImporterType.Sprite;
            importer.spriteImportMode = SpriteImportMode.Single; // textureType=Sprite alone doesn't reliably generate the sprite sub-asset without this — the actual bug behind "Sprite: None" persisting through the previous fix
            importer.spritePixelsPerUnit = texturePixels / worldSize;
            importer.filterMode = FilterMode.Point;
            importer.SaveAndReimport();

            var sprite = AssetDatabase.LoadAssetAtPath<Sprite>(path);
            if (sprite == null)
            {
                Debug.LogError($"[Attest Fixture] Failed to load Sprite from {path} after import — " +
                    $"textureType={importer.textureType}, spriteImportMode={importer.spriteImportMode}. " +
                    "If you see this, that's the actual bug to report back, not just 'still None'.");
            }
            return sprite;
        }

        /// <summary>
        /// Assigns a private [SerializeField] object reference via
        /// SerializedObject/SerializedProperty rather than reflection —
        /// the same discipline spec principle 3 requires of Attest's own
        /// mutations (see class doc comment).
        /// </summary>
        private static void SetPrivateRef(Object target, string fieldName, Object value)
        {
            var so = new SerializedObject(target);
            var prop = so.FindProperty(fieldName);
            if (prop == null)
            {
                Debug.LogError($"[Attest Fixture] No serialized field '{fieldName}' on {target.GetType().Name}");
                return;
            }
            prop.objectReferenceValue = value;
            so.ApplyModifiedPropertiesWithoutUndo();
        }
    }
}
