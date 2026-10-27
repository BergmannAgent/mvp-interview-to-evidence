import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export interface MediaDeviceOption {
  readonly deviceId: string;
  readonly label: string | null;
  readonly ordinal: number;
}

export type MediaPreviewErrorCode = 'enumeration_failed' | 'permission_denied' | 'unsupported';

export interface MediaPreviewState {
  readonly videoRef: RefObject<HTMLVideoElement | null>;
  readonly cameraEnabled: boolean;
  readonly microphoneEnabled: boolean;
  readonly cameras: readonly MediaDeviceOption[];
  readonly microphones: readonly MediaDeviceOption[];
  readonly cameraDeviceId: string;
  readonly microphoneDeviceId: string;
  readonly error: MediaPreviewErrorCode | null;
  readonly pending: boolean;
  setCameraEnabled(enabled: boolean): void;
  setMicrophoneEnabled(enabled: boolean): void;
  setCameraDeviceId(deviceId: string): void;
  setMicrophoneDeviceId(deviceId: string): void;
}

export function useMediaPreview(): MediaPreviewState {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const requestSequence = useRef(0);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  const [cameras, setCameras] = useState<readonly MediaDeviceOption[]>([]);
  const [microphones, setMicrophones] = useState<readonly MediaDeviceOption[]>([]);
  const [cameraDeviceId, setCameraDeviceId] = useState('');
  const [microphoneDeviceId, setMicrophoneDeviceId] = useState('');
  const [error, setError] = useState<MediaPreviewErrorCode | null>(null);
  const [pending, setPending] = useState(false);

  const refreshDevices = useCallback(async (): Promise<void> => {
    if (!supportsMediaDevices()) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = deviceOptions(devices, 'videoinput');
      const audioInputs = deviceOptions(devices, 'audioinput');
      setCameras(videoInputs);
      setMicrophones(audioInputs);
      setCameraDeviceId((current) => current || videoInputs[0]?.deviceId || '');
      setMicrophoneDeviceId((current) => current || audioInputs[0]?.deviceId || '');
    } catch {
      setError('enumeration_failed');
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
    if (!supportsMediaDevices()) return undefined;
    const onDeviceChange = (): void => void refreshDevices();
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
    return () => navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
  }, [refreshDevices]);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    let disposed = false;
    stopStream(streamRef.current);
    streamRef.current = null;
    if (videoRef.current !== null) videoRef.current.srcObject = null;

    if (!cameraEnabled && !microphoneEnabled) {
      setPending(false);
      setError(null);
      return undefined;
    }
    if (!supportsMediaDevices()) {
      setPending(false);
      setError('unsupported');
      return undefined;
    }

    setPending(true);
    setError(null);
    const video: MediaTrackConstraints | boolean = cameraEnabled
      ? cameraDeviceId.length > 0
        ? { deviceId: { exact: cameraDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
        : { width: { ideal: 1280 }, height: { ideal: 720 } }
      : false;
    const audio: MediaTrackConstraints | boolean = microphoneEnabled
      ? microphoneDeviceId.length > 0
        ? { deviceId: { exact: microphoneDeviceId }, echoCancellation: true }
        : { echoCancellation: true }
      : false;

    void navigator.mediaDevices
      .getUserMedia({ video, audio })
      .then(async (stream) => {
        if (disposed || sequence !== requestSequence.current) {
          stopStream(stream);
          return;
        }
        streamRef.current = stream;
        if (videoRef.current !== null) videoRef.current.srcObject = stream;
        setPending(false);
        await refreshDevices();
      })
      .catch(() => {
        if (sequence !== requestSequence.current) return;
        setPending(false);
        setError('permission_denied');
        setCameraEnabled(false);
        setMicrophoneEnabled(false);
      });

    return () => {
      disposed = true;
      if (sequence === requestSequence.current) {
        stopStream(streamRef.current);
        streamRef.current = null;
      }
    };
  }, [cameraDeviceId, cameraEnabled, microphoneDeviceId, microphoneEnabled, refreshDevices]);

  return {
    videoRef,
    cameraEnabled,
    microphoneEnabled,
    cameras,
    microphones,
    cameraDeviceId,
    microphoneDeviceId,
    error,
    pending,
    setCameraEnabled,
    setMicrophoneEnabled,
    setCameraDeviceId,
    setMicrophoneDeviceId,
  };
}

function supportsMediaDevices(): boolean {
  return typeof navigator !== 'undefined' && navigator.mediaDevices !== undefined;
}

function deviceOptions(
  devices: readonly MediaDeviceInfo[],
  kind: MediaDeviceKind,
): readonly MediaDeviceOption[] {
  return devices
    .filter((device) => device.kind === kind)
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label.trim().length > 0 ? device.label : null,
      ordinal: index + 1,
    }));
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}
