export function InterruptedOverlay({
  reason,
  onReturn,
}: {
  reason?: string
  onReturn: () => void
}) {
  return (
    <div
      style={{
        background: '#1e293b',
        padding: '32px 40px',
        borderRadius: 12,
        border: '1px solid #ef4444',
        boxShadow: '0 20px 25px -5px rgba(0,0,0,0.5)',
        width: 380,
        textAlign: 'center',
      }}
    >
      <h2 style={{ margin: '0 0 8px 0', fontSize: 24, color: '#ef4444' }}>
        Connection Interrupted
      </h2>
      <p style={{ margin: '0 0 24px 0', fontSize: 14, color: '#94a3b8' }}>
        {reason || 'The opponent has left the match or connection was lost.'}
      </p>
      <button
        id="btn-return-menu"
        style={{
          padding: '12px 24px',
          background: '#ef4444',
          color: 'white',
          border: 'none',
          borderRadius: 6,
          fontWeight: 600,
          cursor: 'pointer',
        }}
        onClick={onReturn}
      >
        Return to Main Menu
      </button>
    </div>
  )
}
