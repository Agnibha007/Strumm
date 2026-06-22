export type ThemeType = 'Obsidian' | 'Black Cherry' | 'Vinyl Classic' | 'Ocean Drive' | 'Monochrome' | 'Aurora' | 'Sunset Blvd' | 'Rose Garden' | 'Cyberpunk';

export interface UserSettings {
  audioQuality: 'data-saver' | 'balanced' | 'high';
  animations: boolean;
  privacy: 'public' | 'private';
  theme: ThemeType;
  customThemeImage?: string;
  showListeningActivity?: boolean;
  publicPassport?: boolean;
  showTopSongs?: boolean;
  allowRequests?: boolean;
}

export interface UserStatistics {
  totalListeningTime: number; // in seconds
  monthlyListeningTime: number; // in seconds
  topSongs: Array<{ songId: string; playCount: number }>;
  topArtists: Array<{ name: string; playCount: number }>;
}

export interface User {
  id: string;
  email: string;
  username: string;
  displayName: string;
  avatar?: string;
  providers: string[];
  theme: ThemeType;
  customThemeImage?: string;
  createdAt: string;
  settings: UserSettings;
  statistics: UserStatistics;
  badges?: Array<{
    id: string;
    title: string;
    description: string;
    icon?: string;
    earnedAt?: string;
  }>;
}

export interface SongMetadata {
  album?: string;
  genre?: string;
  year?: number;
  lyricsUrl?: string;
  syncedLyrics?: string;
  audioUrl?: string;
  audioVariants?: Partial<Record<'data-saver' | 'balanced' | 'high', string>>;
  videoAvailable?: boolean;
  videoUrl?: string | null;
  mediaType?: "audio" | "video";
  description?: string;
}

export interface Song {
  videoId: string; // primary music identifier
  title: string;
  artist: string;
  thumbnail: string;
  duration: number; // in seconds
  metadata?: SongMetadata;
}

export interface Playlist {
  id: string;
  userId: string;
  name: string;
  description?: string;
  songs: Song[];
  visibility: 'public' | 'private';
  followers: number;
  createdAt: string;
}

export interface LikedSong {
  userId: string;
  song: Song;
  likedAt: string;
}

export interface PlaybackHistory {
  userId: string;
  song: Song;
  listenDuration: number; // in seconds
  playedAt: string;
}

export interface PlayerState {
  userId: string;
  deviceId: string;
  currentSong: Song | null;
  queue: Song[];
  volume: number; // 0 to 1
  currentTime: number; // in seconds
}

export interface Share {
  userId: string;
  contentType: 'song' | 'playlist';
  contentId: string;
  shareToken: string;
  views: number;
  expiry?: string;
}

export interface PodcastShow {
  id: string;
  title: string;
  author: string;
  description: string;
  image: string;
  rss: string;
  categories: string[];
}

export interface PodcastEpisode {
  id: string;
  showId: string;
  title: string;
  audioUrl: string;
  audioVariants?: Partial<Record<'data-saver' | 'balanced' | 'high', string>>;
  duration: number; // in seconds
  description: string;
  publishedAt?: string;
  videoAvailable?: boolean;
  videoUrl?: string | null;
  mediaType?: "audio" | "video";
}
