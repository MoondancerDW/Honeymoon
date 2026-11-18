"""Render the original ambient altitude loop using NumPy."""

from pathlib import Path
import wave

import numpy as np


RATE = 22050
SECONDS = 32
TAU = 2 * np.pi
TIME = np.arange(RATE * SECONDS) / RATE


def oscillator(note):
    hz = 440 * 2 ** ((note - 69) / 12)
    offset = round(hz * SECONDS) / SECONDS
    return TAU * offset * TIME


def position(center):
    return (TIME - center + SECONDS / 2) % SECONDS - SECONDS / 2


def render():
    mix = np.zeros_like(TIME)
    voicings = (
        (45, 52, 55, 60, 64),
        (41, 48, 55, 57, 62),
        (43, 50, 57, 60, 64),
        (38, 45, 53, 57, 60),
    )
    for chord, notes in enumerate(voicings):
        window = np.clip(1 - np.abs(position(4 + 8 * chord)) / 7, 0, 1)
        envelope = np.sin(window * np.pi / 2) ** 2
        for voice, note in enumerate(notes):
            phase = oscillator(note)
            drift = .3 * np.sin(TAU * (voice + 2) * TIME / SECONDS + chord)
            signal = np.sin(phase + drift) + .19 * np.sin(2 * phase + drift * .5)
            mix += envelope * signal * (.115 if voice == 0 else .050)

    melody = ((.9, 76), (3.6, 72), (6.25, 79), (9.1, 74), (13.2, 69),
              (17.3, 76), (20.7, 81), (24.4, 77), (28.2, 74), (30.9, 72))
    for start, note in melody:
        age = position(start)
        attack = 1 - np.exp(-np.maximum(age, 0) / .035)
        tail = np.exp(-np.maximum(age, 0) / 1.45) * np.clip((7 - age) / 1.2, 0, 1)
        phase = oscillator(note)
        bell = np.sin(phase) + .21 * np.sin(2 * phase + .9) + .13 * np.sin(3 * phase)
        mix += .082 * attack * tail * bell

    return (np.tanh(1.55 * mix) * 28000).astype("<i2")


if __name__ == "__main__":
    output = Path(__file__).resolve().parents[1] / "client" / "altitude-theme.wav"
    with wave.open(str(output), "wb") as track:
        track.setnchannels(1)
        track.setsampwidth(2)
        track.setframerate(RATE)
        track.writeframes(render().tobytes())
