// NOT compiled or run against a real Unity Editor — see AttestRpcMessages.cs
// header for why, and the repo root README for the fixture-building
// workaround this same limitation forced for the fixture project.

using System;
using System.IO;
using Newtonsoft.Json;
using UnityEditor;
using UnityEngine;

namespace Attest.Editor.Rpc
{
    /// <summary>
    /// Spec §6: "The session token and in-flight operation ID live in
    /// SessionState (survives domain reload, cleared on Editor restart)
    /// plus a workspace file (survives Editor restart)."
    ///
    /// SessionState alone answers "did I just reconnect because of a domain
    /// reload, or is this a genuinely fresh Editor process?" — that
    /// distinction is what lets AttestConnection report the right `reason`
    /// on `hello` (domain_reload vs editor_restart vs initial_connect),
    /// which is what the daemon's watchdog uses to decide whether an
    /// Editor-restart budget entry should be charged (spec §9.2).
    /// </summary>
    internal static class AttestSessionState
    {
        private const string SessionTokenKey = "Attest.SessionToken";
        private const string LastIdempotencyKeyKey = "Attest.LastIdempotencyKey";
        private const string SeenThisProcessKey = "Attest.SeenThisProcess";

        private static string WorkspaceDir =>
            Path.Combine(Directory.GetParent(Application.dataPath)!.FullName, ".attest");

        private static string WorkspaceFilePath => Path.Combine(WorkspaceDir, "unity-session.json");

        [Serializable]
        private class WorkspaceFile
        {
            public string sessionToken;
            public string lastIdempotencyKey;
        }

        public static string GetSessionToken()
        {
            var fromSessionState = SessionState.GetString(SessionTokenKey, null);
            if (!string.IsNullOrEmpty(fromSessionState)) return fromSessionState;

            // SessionState was cleared (Editor restarted) — fall back to the
            // workspace file, which is exactly the case it exists for.
            var file = ReadWorkspaceFile();
            if (file != null && !string.IsNullOrEmpty(file.sessionToken))
            {
                SessionState.SetString(SessionTokenKey, file.sessionToken);
                return file.sessionToken;
            }
            return null;
        }

        public static void SetSessionToken(string token)
        {
            SessionState.SetString(SessionTokenKey, token);
            WriteWorkspaceFile(token, SessionState.GetString(LastIdempotencyKeyKey, null));
        }

        public static string GetLastIdempotencyKey() => SessionState.GetString(LastIdempotencyKeyKey, null);

        public static void SetLastIdempotencyKey(string key)
        {
            SessionState.SetString(LastIdempotencyKeyKey, key ?? "");
            WriteWorkspaceFile(GetSessionToken(), key);
        }

        public static void ClearLastIdempotencyKey() => SetLastIdempotencyKey(null);

        /// <summary>
        /// True if this static-initializer run is a reconnect within the
        /// SAME Editor process (i.e. triggered by a domain reload or a
        /// Play Mode transition), false if this is the first time this
        /// Editor process has ever initialized Attest (a real fresh start,
        /// or the process itself was just launched/restarted).
        /// </summary>
        public static bool SeenThisProcessBefore()
        {
            var seen = SessionState.GetBool(SeenThisProcessKey, false);
            SessionState.SetBool(SeenThisProcessKey, true);
            return seen;
        }

        private static WorkspaceFile ReadWorkspaceFile()
        {
            try
            {
                if (!File.Exists(WorkspaceFilePath)) return null;
                var json = File.ReadAllText(WorkspaceFilePath);
                return JsonConvert.DeserializeObject<WorkspaceFile>(json);
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[Attest] Failed to read session workspace file: {e.Message}");
                return null;
            }
        }

        private static void WriteWorkspaceFile(string sessionToken, string lastIdempotencyKey)
        {
            try
            {
                Directory.CreateDirectory(WorkspaceDir);
                var payload = new WorkspaceFile { sessionToken = sessionToken, lastIdempotencyKey = lastIdempotencyKey };
                File.WriteAllText(WorkspaceFilePath, JsonConvert.SerializeObject(payload));
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[Attest] Failed to write session workspace file: {e.Message}");
            }
        }
    }
}
