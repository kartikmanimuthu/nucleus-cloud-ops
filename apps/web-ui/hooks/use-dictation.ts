"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * Minimal structural types for the Web Speech API. `lib.dom` does not ship
 * these reliably across TS versions, and we only touch the handful of members
 * below, so we declare them locally rather than pulling in a types package.
 */
interface SpeechRecognitionAlternativeLike {
    transcript: string;
}

interface SpeechRecognitionResultLike {
    readonly length: number;
    readonly isFinal: boolean;
    [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
    readonly length: number;
    [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike {
    readonly resultIndex: number;
    readonly results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike {
    readonly error: string;
}

interface SpeechRecognitionLike {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    maxAlternatives: number;
    start(): void;
    stop(): void;
    abort(): void;
    onresult: ((event: SpeechRecognitionEventLike) => void) | null;
    onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
    onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
    if (typeof window === "undefined") return null;
    const w = window as unknown as {
        SpeechRecognition?: SpeechRecognitionCtor;
        webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Human-readable messages for the error codes worth surfacing to the user. */
const ERROR_MESSAGES: Record<string, string> = {
    "not-allowed": "Microphone access was blocked. Allow it in your browser settings to dictate.",
    "service-not-allowed": "Speech recognition is unavailable in this browser session.",
    "audio-capture": "No microphone was found. Connect one and try again.",
    network: "Speech recognition lost its network connection.",
};

/** Error codes that are normal end-of-utterance signals, not real failures. */
const SILENT_ERRORS = new Set(["no-speech", "aborted"]);

export interface UseDictationOptions {
    /** Current field value — the hook appends to it rather than replacing it. */
    value: string;
    /** Controlled-field setter the transcript is written back through. */
    onChange: (next: string) => void;
    /** When true, an in-flight session is stopped and `toggle` is a no-op. */
    disabled?: boolean;
    /** Mirrors the field's own `maxLength`; the transcript is clamped to it. */
    maxLength?: number;
    /** BCP-47 tag. Defaults to the browser's language, then `en-US`. */
    lang?: string;
}

export interface UseDictation {
    /** False during SSR and on browsers without the Web Speech API. */
    isSupported: boolean;
    isListening: boolean;
    /** Start if idle, stop if listening. */
    toggle: () => void;
    stop: () => void;
}

/**
 * Binds the browser's speech recognition to an already-controlled text field.
 *
 * Dictation *appends*: the value is snapshotted when a session starts, and each
 * `result` event rewrites `snapshot + finalSoFar + interim`. That makes words
 * appear live as they are spoken while the interim tail is swapped for the
 * final transcript instead of being duplicated after it.
 */
export function useDictation({
    value,
    onChange,
    disabled = false,
    maxLength,
    lang,
}: UseDictationOptions): UseDictation {
    const [isSupported, setIsSupported] = useState(false);
    const [isListening, setIsListening] = useState(false);

    const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
    // Value at the moment the session started; every result rebuilds from it.
    const baseRef = useRef("");
    // Final transcript accumulated across result events in this session.
    const finalRef = useRef("");

    // Callbacks below are attached once per session, so read live values via refs.
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const valueRef = useRef(value);
    valueRef.current = value;
    const maxLengthRef = useRef(maxLength);
    maxLengthRef.current = maxLength;

    // Resolved in an effect (not during render) so the server and the first
    // client render agree and hydration does not mismatch.
    useEffect(() => {
        setIsSupported(getSpeechRecognitionCtor() !== null);
    }, []);

    const stop = useCallback(() => {
        const recognition = recognitionRef.current;
        recognitionRef.current = null;
        setIsListening(false);
        if (recognition) {
            recognition.onresult = null;
            recognition.onerror = null;
            recognition.onend = null;
            try {
                recognition.stop();
            } catch {
                // Already stopped — nothing to unwind.
            }
        }
    }, []);

    const start = useCallback(() => {
        const Ctor = getSpeechRecognitionCtor();
        if (!Ctor || recognitionRef.current) return;

        let recognition: SpeechRecognitionLike;
        try {
            recognition = new Ctor();
        } catch {
            toast.error("Voice input could not be started in this browser.");
            return;
        }

        recognition.lang =
            lang ?? (typeof navigator !== "undefined" ? navigator.language : "") ?? "en-US";
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;

        // Start a fresh utterance after whatever is already in the field.
        const existing = valueRef.current;
        baseRef.current = existing && !existing.endsWith(" ") ? `${existing} ` : existing;
        finalRef.current = "";

        recognition.onresult = (event) => {
            let interim = "";
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const result = event.results[i];
                const transcript = result[0]?.transcript ?? "";
                if (result.isFinal) {
                    finalRef.current += transcript;
                } else {
                    interim += transcript;
                }
            }
            let next = baseRef.current + finalRef.current + interim;
            const limit = maxLengthRef.current;
            if (typeof limit === "number" && next.length > limit) {
                next = next.slice(0, limit);
            }
            onChangeRef.current(next);
        };

        recognition.onerror = (event) => {
            if (!SILENT_ERRORS.has(event.error)) {
                toast.error(ERROR_MESSAGES[event.error] ?? "Voice input failed. Please try again.");
            }
            stop();
        };

        recognition.onend = () => {
            // The browser ends the session on its own after a silence timeout.
            recognitionRef.current = null;
            setIsListening(false);
        };

        try {
            recognition.start();
        } catch {
            toast.error("Voice input could not be started. Please try again.");
            return;
        }

        recognitionRef.current = recognition;
        setIsListening(true);
    }, [lang, stop]);

    const toggle = useCallback(() => {
        if (recognitionRef.current) {
            stop();
            return;
        }
        if (disabled) return;
        start();
    }, [disabled, start, stop]);

    // A field that becomes disabled (submitting, streaming) must not keep the
    // mic hot — the transcript would have nowhere to land.
    useEffect(() => {
        if (disabled && recognitionRef.current) stop();
    }, [disabled, stop]);

    // Release the microphone if the field unmounts mid-session.
    useEffect(() => {
        return () => {
            const recognition = recognitionRef.current;
            recognitionRef.current = null;
            if (recognition) {
                recognition.onresult = null;
                recognition.onerror = null;
                recognition.onend = null;
                try {
                    recognition.abort();
                } catch {
                    // Already torn down.
                }
            }
        };
    }, []);

    return { isSupported, isListening, toggle, stop };
}
