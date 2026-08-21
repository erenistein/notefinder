\version "2.26.0"
\header {
  title = "Clean Test Piece"
  composer = "OMR Test"
  tagline = ##f
}
\score {
  \new PianoStaff <<
    \new Staff {
      \clef treble \key c \major \time 4/4 \tempo 4 = 90
      c'4 d'4 e'4 f'4 | g'4 a'4 g'4 e'4 | f'4 e'4 d'4 c'4 | g'2 c'2 |
      e'8 f'8 g'8 a'8 g'4 e'4 | d'4 f'4 e'4 c'4 | a'4 g'4 f'4 e'4 | d'2 g'2 |
      c''4 b'4 a'4 g'4 | f'4 e'4 d'4 c'4 | e'4 g'4 c''4 g'4 | e'2 c'2 \bar "|."
    }
    \new Staff {
      \clef bass \key c \major \time 4/4
      c4 e4 g4 e4 | c4 e4 g4 c'4 | f,4 a,4 c4 a,4 | g,2 c2 |
      c4 g,4 c4 e4 | f,4 a,4 c4 f4 | d4 f4 a4 f4 | g,2 g2 |
      c4 e4 g4 c'4 | f,4 a,4 c4 f4 | c4 e4 g4 e4 | c2 c2 \bar "|."
    }
  >>
  \layout {}
}
