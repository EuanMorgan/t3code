import type { SpotifyAction } from "@t3tools/contracts";
import { MusicIcon, PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { controlSpotify, spotifyStatus } from "./state";

export function SpotifyNowPlaying() {
  const environmentId = usePrimaryEnvironmentId();
  const { data: status } = useEnvironmentQuery(
    environmentId === null ? null : spotifyStatus({ environmentId, input: {} }),
  );
  const control = useAtomCommand(controlSpotify);

  const track = status?.track ?? null;
  if (environmentId === null || track === null) return null;

  const send = (action: SpotifyAction) => void control({ environmentId, input: { action } });

  return (
    <div
      aria-label="Spotify"
      className="flex items-center gap-2 rounded-lg bg-sidebar-control-surface p-1.5"
      role="group"
    >
      {track.artworkUrl === null ? (
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <MusicIcon className="size-4" />
        </div>
      ) : (
        <img alt="" className="size-9 shrink-0 rounded-md" src={track.artworkUrl} />
      )}
      <Tooltip>
        <TooltipTrigger render={<div className="min-w-0 flex-1 leading-tight" />}>
          <div className="truncate text-xs font-medium text-sidebar-foreground">{track.name}</div>
          <div className="truncate text-2xs text-muted-foreground">{track.artist}</div>
        </TooltipTrigger>
        <TooltipPopup side="top">
          {track.name} · {track.artist} · {track.album}
        </TooltipPopup>
      </Tooltip>
      <div className="flex shrink-0 items-center">
        <Button
          aria-label="Previous song"
          onClick={() => send("previous")}
          size="icon-xs"
          variant="ghost"
        >
          <SkipBackIcon />
        </Button>
        <Button
          aria-label={track.playing ? "Pause" : "Play"}
          onClick={() => send("playpause")}
          size="icon-xs"
          variant="ghost"
        >
          {track.playing ? <PauseIcon /> : <PlayIcon />}
        </Button>
        <Button aria-label="Next song" onClick={() => send("next")} size="icon-xs" variant="ghost">
          <SkipForwardIcon />
        </Button>
      </div>
    </div>
  );
}
