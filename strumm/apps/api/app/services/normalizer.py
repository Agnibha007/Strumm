"""
Metadata Normalization helpers for the Python backend.

Provides canonical string generation used for fuzzy duplicate detection
in playlist operations, plus a lightweight title cleaner.

These helpers mirror the frontend's canonical.ts logic so that both
sides produce identical canonical keys for the same input.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Set

# ---------------------------------------------------------------------------
# Noise-word sets (must match frontend canonical.ts)
# ---------------------------------------------------------------------------

NOISE_WORDS: Set[str] = {
    "official",
    "lyrics",
    "lyric",
    "video",
    "audio",
    "remastered",
    "hd",
    "hq",
    "4k",
    "visualizer",
    "full song",
    "song",
    "music video",
}

# ---------------------------------------------------------------------------
# Emoji / decorative Unicode ranges (must match frontend)
# ---------------------------------------------------------------------------

# Emoji and decorative symbol pattern — uses Unicode categories so we don't need
# to enumerate every known emoji codepoint.  Matches any character in the "So"
# (Symbol, Other) category plus common pictographic ranges.
EMOJI_RE = re.compile(
    "["
    "\U0001F600-\U0001F64F"   # Emoticons
    "\U0001F300-\U0001F5FF"   # Misc Symbols & Pictographs
    "\U0001F680-\U0001F6FF"   # Transport & Map
    "\U0001F1E0-\U0001F1FF"   # Regional Indicators
    "\U00002600-\U000026FF"   # Misc symbols
    "\U00002700-\U000027BF"   # Dingbats
    "\U0000FE00-\U0000FE0F"   # Variation Selectors
    "\U0001F900-\U0001F9FF"   # Supplemental Symbols
    "\U0001FA00-\U0001FA6F"   # Chess Symbols
    "\U0001FA70-\U0001FAFF"   # Symbols Extended-A
    "]+",
    re.UNICODE,
)

# ---------------------------------------------------------------------------
# Artist-specific noise patterns (mirrors frontend ArtistNormalizer.ts)
# ---------------------------------------------------------------------------

ARTIST_SUFFIX_PATTERNS = [
    re.compile(r"\s*-\s*Topic\s*$", re.IGNORECASE),
    re.compile(r"\s*Official\s+Artist\s*$", re.IGNORECASE),
    re.compile(r"\s*Official\s*$", re.IGNORECASE),
    re.compile(r"\s*VEVO\s*$", re.IGNORECASE),
    re.compile(r"\s*[Oo]n\s+[Ss]potify\s*$", re.IGNORECASE),
    re.compile(r"\s*Music\s*$", re.IGNORECASE),
    re.compile(r"\s*Records\s*$", re.IGNORECASE),
    re.compile(r"\s*Channel\s*$", re.IGNORECASE),
    re.compile(r"\s*-\s*Subject\s*$", re.IGNORECASE),
]

ARTIST_NOISE_WORDS = {
    "official", "artist", "vevo", "topic", "music", "records", "channel", "subject",
}


def normalize_artist(artist: str) -> str:
    """
    Strip YouTube channel suffixes from an artist name for clean display.
    Preserves original casing.
    """
    if not artist:
        return artist
    normalized = artist.strip()
    for pattern in ARTIST_SUFFIX_PATTERNS:
        normalized = pattern.sub("", normalized)
    # Handle camelCase VEVO
    normalized = re.sub(r"([a-z])([A-Z])", r"\1 \2", normalized)
    return normalized.strip() or artist.strip()


def canonical_artist(raw: str) -> str:
    """
    Build a canonical artist key for grouping, dedup, and comparison.
    Mirrors frontend `canonicalArtist()` from ArtistNormalizer.ts.
    """
    if not raw:
        return raw
    s = unicodedata.normalize("NFC", raw)
    s = s.lower()
    s = EMOJI_RE.sub("", s)

    # Strip YouTube suffixes
    for pattern in ARTIST_SUFFIX_PATTERNS:
        s = pattern.sub("", s)
    s = re.sub(r"([a-z])([A-Z])", r"\1 \2", s)

    # Remove noise words
    noise_pattern = r"\b(?:{})\b".format("|".join(re.escape(w) for w in ARTIST_NOISE_WORDS))
    s = re.sub(noise_pattern, "", s, flags=re.IGNORECASE)

    # Remove punctuation except hyphens inside words
    s = re.sub(r"[^\w\s-]", " ", s, flags=re.UNICODE)

    # Collapse whitespace
    s = re.sub(r"\s+", " ", s).strip()

    # Strip diacritics
    decomposed = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")

    return s


def are_same_artist(a: str, b: str) -> bool:
    return canonical_artist(a) == canonical_artist(b)


# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------


def canonical_string(raw: str) -> str:
    """
    Build a canonical form from a title or artist name.

    Rules (must mirror frontend `canonicalString`):
      1. NFC-normalise
      2. Lowercase
      3. Remove emojis
      4. Remove known noise words (whole word only)
      5. Remove all punctuation except hyphens inside words
      6. Collapse whitespace
      7. Strip diacritics (NFD → remove combining marks)
      8. Trim
    """
    s = unicodedata.normalize("NFC", raw)

    # 1. Lowercase
    s = s.lower()

    # 2. Strip emojis
    s = EMOJI_RE.sub("", s)

    # 3. Remove noise words (whole word only)
    noise_pattern = r"\b(?:{})\b".format("|".join(re.escape(w) for w in NOISE_WORDS))
    s = re.sub(noise_pattern, "", s, flags=re.IGNORECASE)

    # 4. Remove punctuation except hyphens inside words
    s = re.sub(r"[^\w\s-]", " ", s, flags=re.UNICODE)

    # 5. Collapse whitespace
    s = re.sub(r"\s+", " ", s).strip()

    # 6. Strip diacritics
    decomposed = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")

    return s


def canonical_song_key(title: str, artist: str) -> str:
    """Build a dedup key: ``canonicalTitle|canonicalArtist``."""
    return f"{canonical_string(title)}|{canonical_artist(artist)}"


# ---------------------------------------------------------------------------
# Genre classification (shared between recommendation engine and user stats)
# ---------------------------------------------------------------------------


def classify_genre(artist: str, title: str) -> str:
    """Classify a song's genre based on artist name and title keywords."""
    artist_lower = artist.lower()
    title_lower = title.lower()

    # Alternative & Rock
    if any(a in artist_lower for a in ["radiohead", "neighbourhood", "djo", "lrb", "rock", "metal", "pink floyd", "linkin park", "coldplay"]):
        return "Alternative & Rock"

    # Rabindra Sangeet / Bengali Classic
    if any(a in artist_lower for a in ["hemanta", "hemant", "sandhya", "manna", "kishore kumar", "lata mangeshkar", "mukherjee", "roy", "nachiketa", "anupam"]):
        if any(w in title_lower for w in ["tumi", "ke", "chhabi", "gaan", "robindra", "rabindra"]):
            return "Rabindra Sangeet"
        return "Bengali Classic"

    # Bollywood & Romantic
    if any(a in artist_lower for a in ["arijit", "pritam", "mithoon", "shaan", "udit narayan", "sujatha", "himesh", "rdb", "lata", "asha", "rafi", "mishra", "nehawal", "aditya rikhari", "anuv jain"]):
        return "Bollywood & Romantic"

    # Ambient & Lo-Fi
    if any(w in title_lower or w in artist_lower for w in ["lo-fi", "sleep", "binaural", "serenity", "delta", "theta", "relax", "meditation", "waves", "ambient"]):
        return "Ambient & Lo-Fi"

    # Pop & Indie
    if any(a in artist_lower for a in ["shawn mendes", "taylor swift", "direction", "sheeran", "bieber", "perri", "kid laroi", "maddie zahm", "yung kai", "pop", "indie"]):
        return "Pop & Indie"

    return "Pop & Indie"


def generate_canonical_for_song(song: dict) -> str:
    """
    Convenience: generate a canonical key from a song dict.

    Accepts dicts with either ``title``/``artist`` keys (frontend style)
    or ``song.title``/``song.artist`` (nested DB style).
    """
    title = song.get("title") or (song.get("song") or {}).get("title") or ""
    artist = song.get("artist") or (song.get("song") or {}).get("artist") or ""
    return canonical_song_key(str(title), str(artist))


# ---------------------------------------------------------------------------
# YouTube title / artist cleaning for external API searches (LRCLIB etc.)
# ---------------------------------------------------------------------------

# Ordered: longer / more specific patterns first so they match before
# shorter overlapping patterns.
_TITLE_CLUTTER_PATTERNS: list[re.Pattern] = [
    # Full phrases with flexible delimiters
    re.compile(
        r"(?:^|\s|-|\||—|:)\s*"
        r"(?:Official\s+(?:Music\s+)?Video|Official\s+Audio|Official\s+Lyric\s+Video)"
        r"\s*(?=$|\s|-|\||—|:)",
        re.IGNORECASE,
    ),
    re.compile(r"(?:^|\s|-|\||—|:)\s*Music\s+Video\s*(?=$|\s|-|\||—|:)", re.IGNORECASE),
    re.compile(r"(?:^|\s|-|\||—|:)\s*Lyric\s+Video\s*(?=$|\s|-|\||—|:)", re.IGNORECASE),
    re.compile(r"(?:^|\s|-|\||—|:)\s*Full\s+Song\s*(?=$|\s|-|\||—|:)", re.IGNORECASE),
    re.compile(r"(?:^|\s|-|\||—|:)\s*Video\s+Song\s*(?=$|\s|-|\||—|:)", re.IGNORECASE),
    # Single-word clutter
    re.compile(r"\s*\(?\b(?:Lyrics?|Lyrical)\b\)?\s*", re.IGNORECASE),
    re.compile(r"\s*\(?\b(?:HD|HQ|4K)\b\)?\s*", re.IGNORECASE),
    re.compile(r"\s*\(?\bVisualizer\b\)?\s*", re.IGNORECASE),
    re.compile(r"\s*\(?\bRemastered\b\)?\s*", re.IGNORECASE),
    # Prefix patterns
    re.compile(r"^(?:Lyrics?|Lyrical|Song|Video)\s*[:|-]\s*", re.IGNORECASE),
]

# Parenthesised / bracketed noise
_BRACKET_NOISE_PATTERNS: list[re.Pattern] = [
    re.compile(
        r"\((?:\s*(?:Official|Music\s+Video|Audio|Lyrics?|Lyric\s+Video"
        r"|HD|HQ|4K|Full\s+Song|Video\s+Song|Visualizer|Remastered)\s*)\)",
        re.IGNORECASE,
    ),
    re.compile(
        r"\[(?:\s*(?:Official|Music\s+Video|Audio|Lyrics?|Lyric\s+Video"
        r"|HD|HQ|4K|Full\s+Song|Video\s+Song|Visualizer|Remastered)\s*)\]",
        re.IGNORECASE,
    ),
    re.compile(r"\((?:\s*[Oo]fficial\s*)\)", re.IGNORECASE),
    re.compile(r"\[(?:\s*[Oo]fficial\s*)\]", re.IGNORECASE),
]

# Pipe-separated channel suffix (e.g. "Song Title | ChannelName")
# Leading / trailing delimiter runs
_LEADING_DELIM_RE = re.compile(r"^[\s\-–—|:;.,/\\]+")
_TRAILING_DELIM_RE = re.compile(r"[\s\-–—|:;.,/\\]+$")

# Feat / ft patterns — used by both title and artist cleaning
_FEAT_TITLE_RE = re.compile(
    r"\s*[(\[]?\s*(?:feat\.?|ft\.?)\s+[^(\[]*$", re.IGNORECASE
)

def clean_youtube_title(title: str) -> str:
    """
    Clean a raw YouTube video title for use in external API searches
    (e.g. LRCLIB lyrics lookup).

    Mirrors the frontend ``MetadataNormalizer.cleanTitle()`` logic:
      1. Remove bracketed noise
      2. Remove known clutter phrases
      3. Remove feat/ft suffixes (keep only main title)
      4. Remove leading/trailing delimiters
      5. Collapse whitespace
    """
    if not title:
        return title

    t = title

    # 1. Bracketed noise
    for pattern in _BRACKET_NOISE_PATTERNS:
        t = pattern.sub("", t)

    # 2. Known clutter phrases
    for pattern in _TITLE_CLUTTER_PATTERNS:
        t = pattern.sub(" ", t)

    # 3. Strip feat/ft from title (keep only the main song name)
    #    e.g. "Tum Hi Ho (feat. Arijit Singh)" → "Tum Hi Ho"
    t = _FEAT_TITLE_RE.sub("", t)

    # 4. Leading/trailing delimiters
    t = _LEADING_DELIM_RE.sub("", t)
    t = _TRAILING_DELIM_RE.sub("", t)

    # 4b. Pipe-separated channel suffix
    t = re.sub(r"\s*\|\s*\S[\s\S]*$", "", t)

    # 5. Collapse whitespace
    t = re.sub(r"\s+", " ", t).strip()

    return t or title.strip()


def clean_youtube_artist(artist: str) -> str:
    """
    Clean a raw YouTube artist / channel name for use in external API
    searches (e.g. LRCLIB lyrics lookup).

    Reuses existing ``ARTIST_SUFFIX_PATTERNS`` to strip channel suffixes
    (VEVO, Topic, Official, etc.).
    """
    if not artist:
        return artist

    a = artist.strip()

    # Strip known suffixes (reuse existing patterns)
    for pattern in ARTIST_SUFFIX_PATTERNS:
        a = pattern.sub("", a)

    # camelCase VEVO → split "ArijitSinghVEVO" → "Arijit Singh"
    a = re.sub(r"([a-z])([A-Z])", r"\1 \2", a)

    return a.strip() or artist.strip()
