using AttestFixture.Health;
using UnityEngine;
using UnityEngine.UI;

namespace AttestFixture.HUD
{
    /// <summary>
    /// Spec §17 fixture: "HUD references are assigned through a presenter" —
    /// gameplay code and UI elements are never wired directly to each other;
    /// everything routes through here. A future cooldown indicator (added by
    /// Attest's dash task) is expected to plug into this same presenter
    /// rather than reach into the HUD hierarchy directly.
    /// </summary>
    public class HudPresenter : MonoBehaviour
    {
        [SerializeField] private Health.Health health;
        [SerializeField] private Text healthText;

        private void Update()
        {
            if (health == null || healthText == null) return;
            healthText.text = $"HP: {health.Current}/{health.Max}";
        }
    }
}
