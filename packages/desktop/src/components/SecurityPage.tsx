import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { ClientCommand, HubState } from '@agent-hq/shared';

export function SecurityPage(props: {
  state: HubState;
  send: (command: ClientCommand) => void;
}): JSX.Element {
  const { security } = props.state;
  const [qrUrl, setQrUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (security.pairingQr) {
      void QRCode.toDataURL(security.pairingQr, {
        width: 240,
        margin: 1,
        color: { dark: '#0B0E14', light: '#E8ECF4' },
      }).then((url) => {
        if (alive) setQrUrl(url);
      });
    } else {
      setQrUrl(null);
    }
    return () => {
      alive = false;
    };
  }, [security.pairingQr]);

  return (
    <div style={{ flexGrow: 1, padding: '18px 20px', display: 'grid', gridTemplateColumns: '1.1fr 0.9fr', gap: 14, alignContent: 'start', overflowY: 'auto' }}>
      {/* Paired device */}
      <div className="tcard" style={{ padding: 16 }}>
        <div className="sect">Paired device</div>
        {security.pairedDevice ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
              <span
                className="dot"
                style={{ width: 8, height: 8, background: security.deviceSessions > 0 ? 'var(--green)' : 'var(--ghost)' }}
              />
              <span style={{ fontSize: 14.5, fontWeight: 700 }}>{security.pairedDevice.name}</span>
              <span className="act">
                {security.deviceSessions > 0 ? 'connected · encrypted session' : 'paired · not connected'}
              </span>
            </div>
            <div className="act" style={{ marginTop: 8 }}>
              paired {new Date(security.pairedDevice.pairedAt).toLocaleString()}
            </div>
            <div className="act" style={{ marginTop: 4, color: 'var(--faint)' }}>
              approvals from this device must be signed with its key — the hub verifies before anything runs
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
              <button
                className="btn deny"
                style={{ flexGrow: 0, padding: '8px 16px', borderColor: 'rgba(229,104,92,0.5)', color: 'var(--red)' }}
                onClick={() => props.send({ type: 'device.revoke' })}
              >
                Revoke device
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="empty-note" style={{ marginTop: 10 }}>
              no device paired — one device slot, empty
            </div>
            {security.pairingQr && qrUrl ? (
              <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginTop: 12 }}>
                <img src={qrUrl} alt="pairing QR" style={{ width: 200, height: 200, borderRadius: 8 }} />
                <div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
                    Scan from the Agent HQ Android app. The code carries a one-time token and this PC's public key;
                    keys are pinned on both sides.
                  </div>
                  <div className="act" style={{ marginTop: 8, color: 'var(--amber)' }}>
                    pairing window closes automatically after 2 minutes
                  </div>
                  <div className="act" style={{ marginTop: 6 }}>
                    <a
                      href="#"
                      onClick={(event) => {
                        event.preventDefault();
                        if (security.pairingQr) void navigator.clipboard.writeText(security.pairingQr);
                      }}
                    >
                      copy pairing code
                    </a>{' '}
                    — paste it in the phone app if scanning is unavailable
                  </div>
                  <button
                    className="btn deny"
                    style={{ flexGrow: 0, padding: '7px 14px', marginTop: 10 }}
                    onClick={() => props.send({ type: 'pairing.cancel' })}
                  >
                    Cancel pairing
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="btn approve"
                style={{ flexGrow: 0, padding: '9px 18px', marginTop: 12 }}
                onClick={() => props.send({ type: 'pairing.start' })}
              >
                Pair a device
              </button>
            )}
          </>
        )}
      </div>

      {/* Kill switch */}
      <div className="tcard" style={{ padding: 16, borderColor: 'rgba(229,104,92,0.35)' }}>
        <div className="sect" style={{ color: 'var(--red)' }}>Kill switch</div>
        <button
          style={{
            width: '100%',
            marginTop: 12,
            padding: '15px 0',
            borderRadius: 9,
            background: '#B23B31',
            color: '#fff',
            fontSize: 14,
            fontWeight: 700,
            letterSpacing: 1.5,
          }}
          onClick={() => props.send({ type: 'connection.kill' })}
        >
          KILL CONNECTION
        </button>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.5, marginTop: 10 }}>
          Instantly revokes the phone's keys and tears down its session. Re-pairing requires physical access to this
          PC.
        </div>
      </div>

      {/* PC identity */}
      <div className="tcard" style={{ padding: 16 }}>
        <div className="sect">This PC</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, gap: 12 }}>
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Key fingerprint</span>
          <span className="mono" style={{ fontSize: 11.5 }}>{security.fingerprint || '—'}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, gap: 12 }}>
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Device sessions</span>
          <span className="mono" style={{ fontSize: 11.5 }}>{security.deviceSessions}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, gap: 12 }}>
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>Transport</span>
          <span className="mono" style={{ fontSize: 11.5 }}>X25519 pinned · ChaCha20-Poly1305 · forward secret</span>
        </div>
      </div>
    </div>
  );
}
