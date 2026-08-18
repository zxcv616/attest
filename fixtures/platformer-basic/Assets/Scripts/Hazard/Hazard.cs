using AttestFixture.Health;
using UnityEngine;

namespace AttestFixture.Hazard
{
    [RequireComponent(typeof(Collider2D))]
    public class Hazard : MonoBehaviour
    {
        [SerializeField] private int damage = 1;

        private void OnTriggerEnter2D(Collider2D other)
        {
            var damageable = other.GetComponentInParent<IDamageable>();
            damageable?.ApplyDamage(damage);
        }
    }
}
