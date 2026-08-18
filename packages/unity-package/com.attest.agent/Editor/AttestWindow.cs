// NOT compiled or run against a real Unity Editor — see Rpc/AttestRpcMessages.cs header.

using Attest.Editor.Rpc;
using UnityEditor;
using UnityEngine;

namespace Attest.Editor
{
    /// <summary>
    /// Spec §7 package layout: "RuntimeWindow.cs — Minimal status/consent UI."
    /// Deliberately small for M0 — its only job right now is making
    /// AttestConnection's state observable without opening the Console, so
    /// the very first thing to check once this package is in a real Unity
    /// project is "did the handshake in AttestConnection.cs actually work."
    /// Approval-gated action review (spec §11 approval policy) is M1+, once
    /// there are actions to approve.
    /// </summary>
    public class AttestWindow : EditorWindow
    {
        [MenuItem("Attest/Status")]
        public static void ShowWindow()
        {
            GetWindow<AttestWindow>("Attest");
        }

        private void OnGUI()
        {
            EditorGUILayout.LabelField("Connection", EditorStyles.boldLabel);
            EditorGUILayout.LabelField("State", AttestConnection.State.ToString());
            EditorGUILayout.LabelField("Session token", AttestConnection.SessionToken ?? "(none)");
            if (!string.IsNullOrEmpty(AttestConnection.LastError))
            {
                EditorGUILayout.HelpBox(AttestConnection.LastError, MessageType.Warning);
            }

            EditorGUILayout.Space();
            if (GUILayout.Button("Reconnect"))
            {
                AttestConnection.Reconnect();
            }

            EditorGUILayout.Space();
            EditorGUILayout.LabelField("Last response (debug)", EditorStyles.boldLabel);
            EditorGUILayout.TextArea(AttestConnection.LastResponseJson ?? "(none yet)");
        }

        private void OnInspectorUpdate() => Repaint();
    }
}
