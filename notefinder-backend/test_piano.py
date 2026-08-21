from piano_transcription_inference import PianoTranscription, sample_rate, load_audio
import os

# Ses dosyasini yukle
audio_path = "uploads/6192f34b.wav"
print(f"Ses yukleniyor: {audio_path}")
import librosa
audio, _ = librosa.load(audio_path, sr=sample_rate, mono=True)

# Modeli yukle (ilk seferde model indirilir ~170MB)
print("Model yukleniyor (ilk seferde indirilecek)...")
transcriptor = PianoTranscription(device='cpu', checkpoint_path=None)

# Transkripsiyon yap
output_path = "outputs/6192f34b_piano_ml.mid"
print("Transkripsiyon yapiliyor...")
transcribed = transcriptor.transcribe(audio, output_path)
print(f"Bitti! MIDI kaydedildi: {output_path}")

# Nota sayisini goster
import mido
mid = mido.MidiFile(output_path)
note_count = 0
for track in mid.tracks:
    for msg in track:
        if msg.type == 'note_on' and msg.velocity > 0:
            note_count += 1
print(f"Toplam nota: {note_count}")