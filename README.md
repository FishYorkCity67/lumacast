# Lumacast – Multistream-Studio für Windows

Streamt gleichzeitig zu **Twitch, YouTube, TikTok** (und Kick, Facebook, beliebigem RTMP), mit einer echten **16:9- und 9:16-Leinwand** aus denselben Szenen.

## Starten

- **Installieren / aktualisieren:** Doppelklick auf `Lumacast installieren.cmd`. Das Skript kopiert die App nach `%LOCALAPPDATA%\Programs\Lumacast` und legt Verknüpfungen auf dem Desktop und im Startmenü an. Nach Änderungen am Code einfach erneut ausführen.
- **Benötigt:** FFmpeg (installiert das Skript per `winget install Gyan.FFmpeg`) und Node.js nur für die erste Installation von Electron.

## Erste Schritte

1. Rechts oben bei **Ziele** auf *Hinzufügen* klicken, Plattform wählen und den Streamschlüssel einfügen. *Schlüssel holen* öffnet die richtige Seite.
   - **TikTok:** Server-URL und Schlüssel bekommst du im TikTok LIVE Center / LIVE Producer. Das geht nur, wenn dein Konto LIVE-Zugang hat, und der Schlüssel ändert sich bei jeder Session. TikTok läuft standardmäßig auf der 9:16-Leinwand.
   - **YouTube:** In YouTube Studio *Automatisch starten* aktivieren.
2. Unter **Chat → Einstellungen** Twitch-Kanal und YouTube-Handle eintragen. Das ist nur lesend und braucht kein Login.
3. **Live gehen** drücken: 3-2-1-Countdown, danach sind alle Ziele gleichzeitig live.

## Was Lumacast besonders macht

| Funktion | Kurz erklärt |
|---|---|
| **Doppelte Leinwand** | 16:9 für Twitch/YouTube und 9:16 für TikTok werden gleichzeitig gerendert. Jede Quelle hat pro Leinwand ein eigenes Layout. Dazu gibt es Hochformat-Vorlagen (Smart, Kamera oben/Gameplay unten, Kamerablase, Letterbox) und TikTok-Schutzzonen. |
| **Privacy Shield** | Erkennt das aktive Fenster. Ist z. B. ein Passwortmanager, Banking oder ein Messenger im Fokus, wird der Bildschirm im Stream sofort verwischt. Auslöser-Wörter sind frei einstellbar. Manuell per `Strg+Umschalt+F11`. |
| **Hype-Clips** | Explodiert der Chat, speichert Lumacast automatisch die letzten Sekunden als 16:9- **und** 9:16-Clip und setzt einen Marker. |
| **Sofort-Replay** | Ein Klick oder `Strg+Umschalt+F9` speichert die letzten 30 s in beiden Formaten, fertig für TikTok und Shorts. |
| **Vereinter Chat + Alerts** | Twitch- und YouTube-Chat in einem Feed und als natives Overlay im Stream. Alerts für Subs, Gifts, Raids, Cheers, Super Chats und Mitglieder brauchen keine Extra-Konten. Von Mods gelöschte Nachrichten verschwinden auch aus dem Overlay. |
| **Stimm-Avatar** | PNGtuber, der beim Sprechen hüpft: eigene Bilder oder der eingebaute animierte Avatar. |
| **Automatik** | Szenen wechseln automatisch, wenn ein Spiel den Fokus bekommt oder du still bist. Ein Countdown-Timer kann bei null von „Gleich geht’s los“ auf „Live“ umschalten. |
| **Stream-Rückblick** | Nach dem Stream: Dauer, Chat-Statistik, Clips, Marker und Datenmenge pro Plattform. |

Dazu die Grundausstattung: Szenen mit animierten Übergängen (Luma-Ring, Überblenden, Schieben, Zoom, Wischen) und Quellen für Bildschirm, Fenster, Kamera (runde Ecken, animierte Rahmen), Bild/GIF, Video, Text-Effekte, Timer, Hintergründe und Browser-Widgets. Außerdem ein Audiomixer mit Rauschunterdrückung, Noise Gate und Kompressor, MP4-Aufnahme (absturzsicher über MKV), Marker, globale Tastenkürzel, adaptive Bitrate, Auto-Reconnect pro Ziel und eine Oberfläche auf Deutsch oder Englisch.

## Technik

- Electron 44, keine weiteren Laufzeit-Abhängigkeiten.
- **Video:** Canvas-Compositor → WebCodecs H.264. 16:9 läuft auf der GPU, 9:16 auf der CPU, mit automatischem Ausweichen.
- **Audio:** Web Audio → FFmpeg (AAC).
- **Versand:** Eigener FLV-Muxer mit eingebautem RTMP/RTMPS-Client. Ein Encoding wird an alle Ziele verteilt. Alternativ ist FFmpeg-Versand möglich (Einstellungen → Allgemein).
- **Streamschlüssel:** liegen verschlüsselt per Windows DPAPI in `%APPDATA%\Lumacast\studio.json`.
- **Logs:** `%APPDATA%\Lumacast\logs\lumacast.log`.
- **Aufnahmen und Clips:** `Videos\Lumacast` (änderbar).

## Bekannte Grenzen

- Den TikTok-Chat gibt es nur als Pop-out, weil TikTok keine öffentliche Live-Chat-API hat.
- Antworten im Chat funktioniert über das Pop-out-Fenster der jeweiligen Plattform.
- Der YouTube-Chat nutzt die gleiche Schnittstelle wie youtube.com. Ändert YouTube daran etwas, kann er ausfallen, während der Stream selbst weiterläuft.

## Lizenz

MIT – siehe [LICENSE](LICENSE). Inoffizielles Projekt, nicht mit Twitch, YouTube oder TikTok verbunden.
