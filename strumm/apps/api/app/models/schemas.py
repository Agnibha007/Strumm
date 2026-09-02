from pydantic import BaseModel, Field, EmailStr, field_validator
from typing import List, Optional, Dict, Any
from datetime import datetime
from app.services.security import PODCAST_EPISODE_ID_RE, is_valid_youtube_id, sanitize_enum, sanitize_multiline_text, sanitize_positive_int, sanitize_text

# --- Common Schemas ---
class SongMetadata(BaseModel):
    model_config = {"extra": "allow"}

    album: Optional[str] = None
    genre: Optional[str] = None
    year: Optional[int] = None
    lyricsUrl: Optional[str] = None
    syncedLyrics: Optional[str] = None
    audioUrl: Optional[str] = None
    audioVariants: Optional[Dict[str, str]] = None

class SongSchema(BaseModel):
    model_config = {"extra": "allow"}

    videoId: Optional[str] = Field(None, description="YouTube video ID, primary music identifier")
    title: str
    artist: str
    thumbnail: str
    duration: int = Field(..., description="Duration in seconds")
    metadata: Optional[SongMetadata] = None

    @field_validator("videoId")
    @classmethod
    def validate_video_id(cls, value: Optional[str]) -> Optional[str]:
        if not value:
            return value
        cleaned = value.strip()
        # Songs persisted via SongSchema must carry either a canonical YouTube
        # video ID or a synthetic podcast-episode videoId. Anything else is
        # rejected (raise) so malformed external ids never reach storage.
        if is_valid_youtube_id(cleaned) or PODCAST_EPISODE_ID_RE.fullmatch(cleaned):
            return cleaned
        raise ValueError("Invalid YouTube video ID.")

    @field_validator("title", "artist")
    @classmethod
    def clean_short_text(cls, value: str) -> str:
        cleaned = sanitize_text(value, max_length=160)
        if not cleaned:
            raise ValueError("Song title and artist are required.")
        return cleaned

    @field_validator("thumbnail")
    @classmethod
    def clean_thumbnail(cls, value: str) -> str:
        return sanitize_text(value, max_length=500)

    @field_validator("duration", mode="before")
    @classmethod
    def validate_duration(cls, value: Any) -> int:
        if value is None:
            return 0
        try:
            val = int(round(float(value)))
        except (ValueError, TypeError):
            val = 0
            
        if val > 86400:
            val = val // 1000
            
        if val < 0:
            val = 0
        elif val > 86400:
            val = 86400
            
        return val

# --- User & Settings ---
class UserSettingsSchema(BaseModel):
    audioQuality: str = "balanced"
    animations: bool = True
    privacy: str = "public"
    theme: str = "Obsidian"
    customThemeImage: Optional[str] = None
    showListeningActivity: bool = True
    publicPassport: bool = True
    showTopSongs: bool = True
    allowRequests: bool = True

    @field_validator("audioQuality")
    @classmethod
    def validate_audio_quality(cls, value: str) -> str:
        normalized = {"low": "data-saver", "medium": "balanced"}.get(value, value)
        return sanitize_enum(normalized, {"data-saver", "balanced", "high"}, "balanced")

    @field_validator("privacy")
    @classmethod
    def validate_privacy(cls, value: str) -> str:
        return sanitize_enum(value, {"public", "private"}, "public")

    @field_validator("theme", "customThemeImage")
    @classmethod
    def clean_optional_settings_text(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        return sanitize_text(value, max_length=500)

class UserStatisticsSchema(BaseModel):
    totalListeningTime: int = 0
    monthlyListeningTime: int = 0
    topSongs: List[Dict[str, Any]] = []
    topArtists: List[Dict[str, Any]] = []

class UserSchema(BaseModel):
    email: EmailStr
    username: str
    displayName: str
    avatar: Optional[str] = None
    providers: List[str] = []
    theme: str = "Obsidian"
    customThemeImage: Optional[str] = None
    settings: UserSettingsSchema = Field(default_factory=UserSettingsSchema)
    statistics: UserStatisticsSchema = Field(default_factory=UserStatisticsSchema)
    badges: List[Dict[str, Any]] = []
    createdAt: datetime = Field(default_factory=datetime.utcnow)

# --- Playlists ---
class PlaylistSchema(BaseModel):
    userId: str
    name: str
    description: Optional[str] = None
    songs: List[SongSchema] = []
    visibility: str = "private" # public, private
    followers: int = 0
    createdAt: datetime = Field(default_factory=datetime.utcnow)

class PlaylistCreateSchema(BaseModel):
    name: str
    description: Optional[str] = None
    visibility: Optional[str] = "private"

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        cleaned = sanitize_text(value, max_length=120)
        if not cleaned:
            raise ValueError("Playlist name is required.")
        return cleaned

    @field_validator("description")
    @classmethod
    def clean_description(cls, value: Optional[str]) -> Optional[str]:
        return sanitize_multiline_text(value, max_length=1000) if value is not None else None

    @field_validator("visibility")
    @classmethod
    def validate_visibility(cls, value: Optional[str]) -> str:
        return sanitize_enum(value, {"public", "private"}, "private")

class PlaylistUpdateSchema(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    visibility: Optional[str] = None
    songs: Optional[List[SongSchema]] = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        cleaned = sanitize_text(value, max_length=120)
        if not cleaned:
            raise ValueError("Playlist name cannot be empty.")
        return cleaned

    @field_validator("description")
    @classmethod
    def clean_description(cls, value: Optional[str]) -> Optional[str]:
        return sanitize_multiline_text(value, max_length=1000) if value is not None else None

    @field_validator("visibility")
    @classmethod
    def validate_visibility(cls, value: Optional[str]) -> Optional[str]:
        return sanitize_enum(value, {"public", "private"}, "private") if value is not None else None

# --- Likes & History ---
class LikedSongSchema(BaseModel):
    userId: str
    song: SongSchema
    likedAt: datetime = Field(default_factory=datetime.utcnow)

class PlaybackHistorySchema(BaseModel):
    userId: str
    song: SongSchema
    listenDuration: int
    playedAt: datetime = Field(default_factory=datetime.utcnow)

class PlayerStateSchema(BaseModel):
    userId: str
    deviceId: str
    currentSong: Optional[SongSchema] = None
    queue: List[SongSchema] = []
    volume: float = 0.8
    currentTime: float = 0.0

# --- Sharing ---
class ShareSchema(BaseModel):
    userId: str
    contentType: str # song, playlist
    contentId: str
    shareToken: str
    views: int = 0
    expiry: Optional[datetime] = None

# --- Podcasts ---
class PodcastShowSchema(BaseModel):
    title: str
    author: str
    description: str
    image: str
    rss: str
    categories: List[str] = []

class PodcastEpisodeSchema(BaseModel):
    showId: str
    title: str
    audioUrl: str
    audioVariants: Dict[str, str] = {}
    duration: int
    description: str
    publishedAt: Optional[datetime] = None

# --- API Response Format ---
class APIResponse(BaseModel):
    success: bool
    data: Optional[Any] = None
    error: Optional[str] = None
