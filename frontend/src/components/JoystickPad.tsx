import React, { useRef, useState, useCallback, useEffect } from 'react';

interface JoystickPadProps {
  direction: number;
  intensity: number;
  onMove: (direction: number, intensity: number) => void;
  onRelease: () => void;
}

const PAD_RADIUS = 70;
const HANDLE_RADIUS = 22;
const MAX_DISTANCE = PAD_RADIUS - HANDLE_RADIUS;

const JoystickPad: React.FC<JoystickPadProps> = ({
  direction,
  intensity,
  onMove,
  onRelease,
}) => {
  const padRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [handlePos, setHandlePos] = useState({ x: 0, y: 0 });

  const getDirectionLabel = (deg: number): string => {
    // deg is compass degrees: 0=N, 90=E, 180=S, 270=W
    const d = ((deg % 360) + 360) % 360;
    if (d >= 337.5 || d < 22.5) return '北';
    if (d >= 22.5 && d < 67.5) return '東北';
    if (d >= 67.5 && d < 112.5) return '東';
    if (d >= 112.5 && d < 157.5) return '東南';
    if (d >= 157.5 && d < 202.5) return '南';
    if (d >= 202.5 && d < 247.5) return '西南';
    if (d >= 247.5 && d < 292.5) return '西';
    return '西北';
  };

  const calcFromEvent = useCallback(
    (clientX: number, clientY: number) => {
      if (!padRef.current) return;
      const rect = padRef.current.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      let dx = clientX - centerX;
      let dy = -(clientY - centerY); // Invert Y for math coords

      const distance = Math.sqrt(dx * dx + dy * dy);
      const clampedDist = Math.min(distance, MAX_DISTANCE);
      const normIntensity = clampedDist / MAX_DISTANCE;

      // Convert to compass degrees: 0=N, 90=E, 180=S, 270=W
      // atan2(dx, dy) gives 0=N, π/2=E, matching compass convention
      const radians = Math.atan2(dx, dy);
      let compassDeg = (radians * 180) / Math.PI;
      if (compassDeg < 0) compassDeg += 360;

      // Clamp handle position visually
      const scale = distance > 0 ? clampedDist / distance : 0;
      const visualX = dx * scale;
      const visualY = -(dy * scale); // Back to screen coords

      setHandlePos({ x: visualX, y: visualY });
      onMove(Math.round(compassDeg), normIntensity);
    },
    [onMove]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      setDragging(true);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      calcFromEvent(e.clientX, e.clientY);
    },
    [calcFromEvent]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      calcFromEvent(e.clientX, e.clientY);
    },
    [dragging, calcFromEvent]
  );

  const handlePointerUp = useCallback(() => {
    setDragging(false);
    setHandlePos({ x: 0, y: 0 });
    onRelease();
  }, [onRelease]);

  // Direction arrows around the pad
  const arrows = [
    { deg: 0, label: '東', x: PAD_RADIUS + 20, y: 0 },
    { deg: 90, label: '北', x: 0, y: -(PAD_RADIUS + 20) },
    { deg: 180, label: '西', x: -(PAD_RADIUS + 20), y: 0 },
    { deg: 270, label: '南', x: 0, y: PAD_RADIUS + 20 },
  ];

  return (
    <div
      className="joystick-overlay"
      style={{
        position: 'absolute',
        bottom: 60,
        right: 20,
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        userSelect: 'none',
        touchAction: 'none',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: PAD_RADIUS * 2 + 50,
          height: PAD_RADIUS * 2 + 50,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* Direction labels */}
        {arrows.map((a) => (
          <div
            key={a.label}
            style={{
              position: 'absolute',
              left: `calc(50% + ${a.x}px)`,
              top: `calc(50% + ${a.y}px)`,
              transform: 'translate(-50%, -50%)',
              fontSize: 11,
              fontWeight: 600,
              color: 'rgba(255,255,255,0.5)',
            }}
          >
            {a.label}
          </div>
        ))}

        {/* Pad background */}
        <div
          ref={padRef}
          className="joystick-pad"
          style={{
            width: PAD_RADIUS * 2,
            height: PAD_RADIUS * 2,
            borderRadius: '50%',
            background: 'rgba(30, 30, 40, 0.75)',
            border: '2px solid rgba(255,255,255,0.15)',
            position: 'relative',
            cursor: 'grab',
            backdropFilter: 'blur(8px)',
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          {/* Crosshair lines */}
          <svg
            width={PAD_RADIUS * 2}
            height={PAD_RADIUS * 2}
            viewBox={`0 0 ${PAD_RADIUS * 2} ${PAD_RADIUS * 2}`}
            style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
          >
            <line x1={PAD_RADIUS} y1="10" x2={PAD_RADIUS} y2={PAD_RADIUS * 2 - 10} stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
            <line x1="10" y1={PAD_RADIUS} x2={PAD_RADIUS * 2 - 10} y2={PAD_RADIUS} stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
            <circle cx={PAD_RADIUS} cy={PAD_RADIUS} r={PAD_RADIUS - 5} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
            <circle cx={PAD_RADIUS} cy={PAD_RADIUS} r={MAX_DISTANCE / 2} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1" strokeDasharray="4 4" />
          </svg>

          {/* Handle */}
          <div
            className="joystick-handle"
            style={{
              width: HANDLE_RADIUS * 2,
              height: HANDLE_RADIUS * 2,
              borderRadius: '50%',
              background: dragging
                ? 'radial-gradient(circle, #6b8afd 0%, #4a6cf7 100%)'
                : 'radial-gradient(circle, #888 0%, #555 100%)',
              border: '2px solid rgba(255,255,255,0.3)',
              position: 'absolute',
              left: PAD_RADIUS - HANDLE_RADIUS + handlePos.x,
              top: PAD_RADIUS - HANDLE_RADIUS + handlePos.y,
              transition: dragging ? 'none' : 'left 0.2s ease-out, top 0.2s ease-out',
              pointerEvents: 'none',
              boxShadow: dragging ? '0 0 12px rgba(74,108,247,0.5)' : '0 2px 6px rgba(0,0,0,0.3)',
            }}
          />
        </div>
      </div>

      {/* Info text */}
      <div
        style={{
          marginTop: 8,
          textAlign: 'center',
          fontSize: 12,
          color: 'rgba(255,255,255,0.7)',
          background: 'rgba(30, 30, 40, 0.65)',
          padding: '4px 12px',
          borderRadius: 4,
          backdropFilter: 'blur(4px)',
        }}
      >
        {intensity > 0.01 ? (
          <>
            {getDirectionLabel(direction)} | {(intensity * 100).toFixed(0)}%
          </>
        ) : (
          '拖曳以移動'
        )}
      </div>
    </div>
  );
};

export default JoystickPad;
