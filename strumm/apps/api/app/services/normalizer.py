"""
Metadata Normalization helpers for the Python backend.

Provides canonical string generation used for fuzzy duplicate detection
in playlist operations, plus a lightweight title cleaner.

These helpers mirror the frontend's canonical.ts logic so that both
sides produce identical canonical keys for the same input.
"""

from __future__ import annotations

import html
import re
import unicodedata
from functools import lru_cache
from typing import Any, Set


def unescape_html(value: Any) -> str:
    """
    Decode HTML entities from a title/artist string.

    Some song metadata (older DB rows, external providers) is HTML-encoded,
    sometimes double-encoded (e.g. ``&amp;quot;``). ``html.unescape`` handles a
    single pass only, so we loop until stable — mirroring the frontend's
    iterative ``decodeHtml``.
    """
    if not value:
        return ""
    prev = None
    result = str(value)
    while result != prev:
        prev = result
        result = html.unescape(result)
    return result


def clean_song_text_fields(node: Any) -> Any:
    """
    Recursively decode HTML entities in song display fields of an API payload.

    Handles ``title``/``artist``/``album``/``name`` keys at any nesting depth
    (e.g. ``song.title``, ``songs[].artist``, playlist ``name``), for both
    new and legacy (already-stored) data.

    Returns the *same* object when nothing changed, so callers can cheaply
    detect whether a payload needed cleaning.
    """
    CLEAN_KEYS = {"title", "artist", "album", "name", "uploaderName", "channelTitle", "showTitle"}

    if isinstance(node, dict):
        rebuilt: dict = {}
        changed = False
        for k, v in node.items():
            if k in CLEAN_KEYS and isinstance(v, str):
                cleaned = unescape_html(v)
                if cleaned != v:
                    changed = True
                rebuilt[k] = cleaned
            else:
                nested = clean_song_text_fields(v)
                if nested is not v:
                    changed = True
                rebuilt[k] = nested
        return rebuilt if changed else node

    if isinstance(node, list):
        rebuilt_list: list = []
        changed = False
        for item in node:
            nested = clean_song_text_fields(item)
            if nested is not item:
                changed = True
            rebuilt_list.append(nested)
        return rebuilt_list if changed else node

    return node

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

# Additional noise words for matching normalization (more aggressive)
MATCH_NOISE_WORDS: Set[str] = {
    "official audio",
    "official video",
    "official music video",
    "official lyric video",
    "lyric video",
    "audio",
    "video",
    "hd",
    "hq",
    "4k",
    "visualizer",
    "full song",
    "song",
    "music video",
    "official",
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

# ---------------------------------------------------------------------------
# Feat / ft patterns
# ---------------------------------------------------------------------------

FEAT_RE = re.compile(r"\b(?:feat\.|ft\.|featuring)\b", re.IGNORECASE)


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
# Enhanced normalization for matching (more aggressive than canonical)
# ---------------------------------------------------------------------------


def normalize_title_for_match(raw: str) -> str:
    """
    Aggressively normalize a song title for fuzzy matching.

    Performs all ``canonical_string`` steps plus:
      1. Normalize brackets: ``(burnt)`` → ``- burnt``, ``[burnt]`` → ``(burnt)``
      2. Replace ``&`` with ``and``
      3. Normalize ``feat.`` / ``ft.`` / ``featuring`` → ``feat``
      4. Remove additional match noise words
      5. Collapse repeated spaces again
    """
    s = _normalize_title_for_match(raw)
    return s


@lru_cache(maxsize=4096)
def _normalize_title_for_match(raw: str) -> str:
    if not raw:
        return raw

    s = unicodedata.normalize("NFC", raw)

    # 1. Normalize brackets: [burnt] → (burnt)
    s = re.sub(r"[\[{]", "(", s)
    s = re.sub(r"[\}\]}]", ")", s)

    # 2. Convert parenthetical to dash notation: (burnt) → - burnt
    s = re.sub(r"\(\s*(.+?)\s*\)", r"- \1", s)

    # 3. Lowercase
    s = s.lower()

    # 4. Strip emojis
    s = EMOJI_RE.sub("", s)

    # 5. Replace & with and
    s = re.sub(r"\s*&\s*", " and ", s)

    # 6. Normalize feat/ft
    s = FEAT_RE.sub("feat", s)

    # 7. Remove noise words
    noise_pattern = r"\b(?:{})\b".format("|".join(re.escape(w) for w in MATCH_NOISE_WORDS))
    s = re.sub(noise_pattern, "", s, flags=re.IGNORECASE)

    # 8. Remove all punctuation (no hyphens kept — more aggressive)
    s = re.sub(r"[^\w\s]", " ", s, flags=re.UNICODE)

    # 9. Collapse whitespace
    s = re.sub(r"\s+", " ", s).strip()

    # 10. Strip diacritics
    decomposed = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")

    return s


@lru_cache(maxsize=2048)
def normalize_artist_for_match(raw: str) -> str:
    """
    Aggressively normalize an artist name for fuzzy matching.
    Strips YouTube suffixes, noise words, and applies canonical normalization.
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

    # Remove punctuation
    s = re.sub(r"[^\w\s]", " ", s, flags=re.UNICODE)

    # Collapse whitespace
    s = re.sub(r"\s+", " ", s).strip()

    # Strip diacritics
    decomposed = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")

    return s


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
        r"\((?:\s*(?:Official\s+(?:Music\s+)?Video|Official\s+Audio"
        r"|Official\s+Lyric\s+Video|Official\s+Lyrics|Music\s+Video"
        r"|Lyric\s+Video|Video\s+Song|Full\s+Song|[Oo]fficial|Audio"
        r"|Lyrics?|Lyrical|HD|HQ|4K|Visualizer|Remastered)\s*)\)",
        re.IGNORECASE,
    ),
    re.compile(
        r"\[(?:\s*(?:Official\s+(?:Music\s+)?Video|Official\s+Audio"
        r"|Official\s+Lyric\s+Video|Official\s+Lyrics|Music\s+Video"
        r"|Lyric\s+Video|Video\s+Song|Full\s+Song|[Oo]fficial|Audio"
        r"|Lyrics?|Lyrical|HD|HQ|4K|Visualizer|Remastered)\s*)\]",
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


# ---------------------------------------------------------------------------
# Display normalization (consumer / emission boundary)
#
# ``normalize_song_display()`` is the single helper applied wherever fresh
# provider metadata is turned into a persisted ``Song`` or a response item
# (playlist import, radio, suggestions). It mirrors the semantic rules of the
# frontend ``MetadataNormalizer`` without duplicating its whole class:
#
#   * clean the display title (bracketed noise, clutter phrases, leading /
#     trailing delimiters, emoji, pipe suffix) — but NOT feat-stripping;
#   * high-precision artist-prefix extraction from "Artist - Title" titles,
#     guarded by a confidence score so false positives (e.g. "Love Me - Love
#     Me") are rejected;
#   * artist resolution priority: title-prefix artist (when split), else
#     structured artists list, else channel-derived artist, else the existing
#     artist field, else "Unknown Artist".
#
# It is idempotent: persisted songs (which only keep ``title`` + ``artist``)
# re-normalize to themselves, so a second pass is a no-op.
# ---------------------------------------------------------------------------

# Dash used as the artist :: title separator
_DASH_TITLE_SEPARATOR = re.compile(r"\s+-\s+")

# Words that appear on the left of " - " but are unlikely to name an artist
ARTIST_SIDE_NOISE_WORDS: frozenset[str] = frozenset({
    "topic", "subject", "official", "officialvideo", "officialmusicvideo",
    "vevo", "lyrics", "lyric", "lyrical", "virtual", "podcast", "mood",
    "chill", "focus", "lofi", "workout", "workout mix", "party", "sleep",
    "study", "gaming", "genre", "subgenre", "cover", "mix", "remix",
    "acoustic", "session", "performance", "live session", "studio session",
    "hits", "best hits", "greatest hits", "top hits", "top 50", "top 100",
    "no copyright sounds", "ncs", "wave", "mood mix",
})

# Words / phrases that indicate the right side of " - " is NOT a song title
SONG_SIDE_VERSION_WORDS: frozenset[str] = frozenset({
    "official", "official video", "official audio", "official music video",
    "official lyric video", "official lyrics", "audio", "video", "lyrics",
    "lyric video", "music video", "mv", "visualizer", "remastered",
    "live", "live session", "studio session", "cover", "acoustic",
    "unplugged", "demo", "bonus track", "deluxe", "extended mix",
    "instrumental", "karaoke", "official hd video", "topic",
})

# Word tokens that can appear inside a plausible artist name
_NAME_TOKEN_RE = re.compile(
    r"^[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'-]*$|^[A-ZÀ-ÖØ-Þ]{1,3}$"
)

# Joiner words that separate artist-list entries (e.g. "A B & C")
ARTIST_LIST_JOINER_WORDS: frozenset[str] = frozenset({
    "&", "and", "×", "x", "feat.", "ft.", "featuring", "feat", "ft",
})

# Small connector words allowed inside an artist name (no giant DB required)
ARTIST_CONNECTOR_WORDS: frozenset[str] = frozenset({
    "of", "the", "and", "a", "an", "de", "la", "le", "da", "do", "van",
    "von", "del", "di", "der", "das", "den", "san", "santa", "bin", "ben",
    "el", "al", "na", "ny", "mc", "mac",
})

_EDGE_PUNCT_RE = re.compile(
    r"^[\s.,'\u2019&\-\u2013\u2014]+|[\s.,'\u2019&\-\u2013\u2014]+$"
)

_ARTIST_LIST_SPLIT_RE = re.compile(
    r"\s*(?:,|\band\b|\b×\b|\bx\b|&|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b)\s*",
    re.IGNORECASE,
)

# Channel-name patterns that imply a single artist (generic, no label DB)
_TOPIC_CHANNEL_RE = re.compile(r"^(.+?)\s*-\s*Topic$", re.IGNORECASE)
_VEVO_CHANNEL_RE = re.compile(r"^(.+?)VEVO$", re.IGNORECASE)
_OFFICIAL_CHANNEL_RES = [
    re.compile(r"^(.+?)\s+Official$", re.IGNORECASE),
    re.compile(r"^(.+?)\s+[Oo]n\s+[Ss]potify$", re.IGNORECASE),
    re.compile(r"^(.+?)\s+[Vv]evo$", re.IGNORECASE),
]
_LABEL_CHANNEL_RES = [
    re.compile(
        r"^(?:[\w\s.&'-]+)\s+(?:music|records?|recordings?|label|labels?|"
        r"company|production|entertainment|official|network|digital|media|"
        r"inc\.?|corp\.?|limited|ltd\.?)\s*$",
        re.IGNORECASE,
    ),
    re.compile(
        r"^(?:the\s+)?(?:music|records?)\s+(?:factory|company|group|network|"
        r"hub|studio|zone|bank|label)\s*$",
        re.IGNORECASE,
    ),
]

_EMOJI_RE = re.compile(
    "[\U0001F600-\U0001F64F\\U0001F300-\\U0001F5FF\\U0001F680-\\U0001F6FF"
    "\\U0001F1E0-\\U0001F1FF\\U00002600-\\U000026FF\\U00002700-\\U000027BF]"
)


def _tokens(text: str) -> list[str]:
    return text.split()


def _strip_edge_punct(token: str) -> str:
    return _EDGE_PUNCT_RE.sub("", token)


def _is_name_like_token(token: str) -> bool:
    return bool(_NAME_TOKEN_RE.match(_strip_edge_punct(token)))


def _is_connector_word(word: str) -> bool:
    return word.lower() in ARTIST_CONNECTOR_WORDS


def _is_joiner_word(word: str) -> bool:
    return word.lower() in ARTIST_LIST_JOINER_WORDS


def _split_artist_list(phrase: str) -> list[str]:
    return [part.strip() for part in _ARTIST_LIST_SPLIT_RE.split(phrase) if part.strip()]


def _artist_list_signal(left: str) -> tuple[bool, bool]:
    """Confidence that the left side of " - " is an artist list."""
    parts = _split_artist_list(left)
    if len(parts) < 2:
        return False, False
    strong = any(len(_tokens(part)) >= 2 for part in parts)
    return strong, not strong


def _name_like_pts(phrase: str) -> int:
    """Points for a left side that is name-like (capped at 2 / 1)."""
    words = _tokens(phrase)
    if not words:
        return 0
    for word in words:
        if _is_joiner_word(word) or _is_connector_word(word):
            continue
        if not _is_name_like_token(word):
            return 0
    return 2 if len(words) <= 2 else 1


def _right_looks_like_title(right: str, left: str) -> int:
    """Points for a right side that reads like a real song title."""
    r = right.strip()
    if not r:
        return 0
    lower = r.lower()
    if lower in SONG_SIDE_VERSION_WORDS:
        return 0
    if re.match(r"^(?:topic|subject|vevo|official)\b", lower):
        return 0
    words = _tokens(r)
    if len(words) >= 2:
        if re.match(r"^(?:the|a|an)\s+", lower):
            return 0
        return 1
    if len(words) == 1:
        strong, _weak = _artist_list_signal(left)
        if len(_tokens(left)) >= 2 or strong:
            return 1
        return 0
    return 0


def _is_label_channel(channel: str) -> bool:
    lower = channel.strip()
    if not lower:
        return False
    return any(pattern.match(channel) for pattern in _LABEL_CHANNEL_RES)


def _channel_confirms_artist(left: str, channel: str) -> int:
    """Points (3) when a channel name pins the artist on the left side."""
    if not channel:
        return 0
    base = None
    m = _TOPIC_CHANNEL_RE.match(channel)
    if m:
        base = m.group(1).strip()
    elif _VEVO_CHANNEL_RE.match(channel):
        base = _VEVO_CHANNEL_RE.sub(r"\1", channel).strip()
    else:
        for pattern in _OFFICIAL_CHANNEL_RES:
            mm = pattern.match(channel)
            if mm:
                base = mm.group(1).strip()
                break
    if base:
        return 3 if canonical_artist(base) == canonical_artist(left) else 0
    if _is_label_channel(channel):
        return 1
    return 3 if canonical_artist(channel) == canonical_artist(left) else 0


def extract_artist_prefix(
    title: str,
    channel: str | None = None,
    known_artist: str | None = None,
) -> tuple[str, str] | None:
    """
    High-precision "Artist - Title" splitting.

    Returns ``(artist, rest_title)`` only when the split is strongly
    supported, or ``None`` otherwise. Mirrors the frontend
    ``MetadataNormalizer.extractArtistPrefix()`` scoring so false positives
    (mirrored halves, "X - Remix", "X - Official", label/VEVO mismatches)
    are rejected.
    """
    if not title:
        return None
    parts = _DASH_TITLE_SEPARATOR.split(title.strip())
    if len(parts) != 2:
        return None
    left = parts[0].strip()
    right = parts[1].strip()
    if not left or not right:
        return None

    # Length guards — a plausible artist / title is short-ish
    if len(left) > 60 or len(right) > 80:
        return None

    if "/" in left:
        return None
    if canonical_string(left) == canonical_string(right):
        return None
    if left.lower() in ARTIST_SIDE_NOISE_WORDS:
        return None
    if right.lower() in SONG_SIDE_VERSION_WORDS:
        return None

    list_strong, list_weak = _artist_list_signal(left)
    channel_pts = _channel_confirms_artist(left, channel or "")
    known_pts = (
        3
        if known_artist and canonical_artist(known_artist) == canonical_artist(left)
        else 0
    )
    name_like_pts = _name_like_pts(left)
    right_pts = _right_looks_like_title(right, left)

    strongly_supported = list_strong or channel_pts >= 3 or known_pts >= 3
    if not strongly_supported and name_like_pts == 0:
        return None

    score = (
        (3 if list_strong else (1 if list_weak else 0))
        + channel_pts
        + known_pts
        + name_like_pts
        + right_pts
    )
    if score < 3:
        return None
    if strongly_supported and right_pts == 0:
        return None

    return (left, right)


def _infer_artist(channel: str) -> str:
    """
    Infer an artist from a generic channel name (Topic / Official or plain).
    Mirror of the frontend ``ArtistNormalizer.inferArtist`` fallback.
    """
    if not channel:
        return ""
    m = _TOPIC_CHANNEL_RE.match(channel)
    if m:
        return m.group(1).strip()
    m = _VEVO_CHANNEL_RE.match(channel)
    if m:
        base = m.group(1).strip()
        return re.sub(r"([a-z])([A-Z])", r"\1 \2", base).strip()
    for pattern in _OFFICIAL_CHANNEL_RES:
        mm = pattern.match(channel)
        if mm:
            return mm.group(1).strip()
    return channel.strip()


def _structured_artist(item: dict) -> str:
    """
    Join the authoritative ``artists`` list when present. Empty when the
    provider only exposes a bare ``artist`` string (not authoritative enough
    to override a confident title-prefix split).
    """
    raw = item.get("artists")
    if not isinstance(raw, list) or not raw:
        return ""
    parts: list[str] = []
    for entry in raw:
        if isinstance(entry, dict):
            name = str(entry.get("name") or "").strip()
        elif isinstance(entry, str):
            name = entry.strip()
        else:
            continue
        if name:
            parts.append(name)
    return ", ".join(parts)


def clean_song_display_title(title: str) -> str:
    """
    Clean a song title for display / persistence.

    Uses the same shared noise lists as ``clean_youtube_title`` but WITHOUT
    feat-stripping (feat stays in the display title), plus emoji and pipe
    suffix removal. Matches the frontend ``MetadataNormalizer.cleanTitle()``.
    """
    if not title:
        return title

    t = title

    for pattern in _BRACKET_NOISE_PATTERNS:
        t = pattern.sub("", t)
    for pattern in _TITLE_CLUTTER_PATTERNS:
        t = pattern.sub(" ", t)
    t = _LEADING_DELIM_RE.sub("", t)
    t = _TRAILING_DELIM_RE.sub("", t)
    t = _EMOJI_RE.sub("", t)
    t = re.sub(r"\s*\|\s*\S[\s\S]*$", "", t)
    t = re.sub(r"\s+", " ", t).strip()

    return t or title.strip()


def normalize_song_display(item: dict) -> dict:
    """
    Normalize a single song's **display** title/artist at the consumer /
    emission boundary (persistence + response building).

    Idempotent: a persisted song carrying only ``title`` + ``artist``
    re-normalizes to itself, so running this twice (or on already-normalized
    results) is a no-op. Never adds canonical fields or mutates the input.
    """
    if not isinstance(item, dict):
        return item
    raw_title = str(item.get("title") or "").strip()
    if not raw_title:
        return item

    known = _structured_artist(item)
    channel = str(
        item.get("channelTitle") or item.get("uploaderName") or item.get("channel") or ""
    ).strip()
    existing = str(item.get("artist") or "").strip()

    cleaned = clean_song_display_title(raw_title) or raw_title
    prefix = extract_artist_prefix(cleaned, channel or None, known or None)

    if prefix:
        display_title = prefix[1]
        base_artist = known or prefix[0]
    else:
        display_title = cleaned
        inferred = _infer_artist(channel)
        fallback = normalize_artist(existing) if existing else ""
        base_artist = known or inferred or fallback

    display_artist = normalize_artist(base_artist or "Unknown Artist")

    result = dict(item)
    result["title"] = display_title
    result["artist"] = display_artist
    return result
