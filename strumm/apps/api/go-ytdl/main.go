package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"sort"
	"time"

	youtube "github.com/lvcoi/ytdl-lib/v2"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: strumm-ytdl-go VIDEO_ID")
		os.Exit(2)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 70*time.Second)
	defer cancel()

	client := youtube.Client{}
	video, err := client.GetVideoContext(ctx, os.Args[1])
	if err != nil {
		fmt.Fprintf(os.Stderr, "video resolution failed: %v\n", err)
		os.Exit(3)
	}

	formats := video.Formats.Type("audio")
	if len(formats) == 0 {
		fmt.Fprintln(os.Stderr, "no audio-only formats available")
		os.Exit(4)
	}
	sort.SliceStable(formats, func(i, j int) bool {
		return formats[i].Bitrate > formats[j].Bitrate
	})

	stream, _, err := client.GetStreamContext(ctx, video, &formats[0])
	if err != nil {
		fmt.Fprintf(os.Stderr, "audio stream request failed: %v\n", err)
		os.Exit(5)
	}
	defer stream.Close()

	if _, err := io.Copy(os.Stdout, stream); err != nil {
		fmt.Fprintf(os.Stderr, "audio stream transfer failed: %v\n", err)
		os.Exit(6)
	}
}
