;==============================================================================
; VTX Speech example cartridge: buttons 1-4 on controller 1 say a phrase.
;
; Build (AS09):   ..\as09\as09_14.exe -l example.asm      -> example.bin
; Data:           python vectrex/export.py vectrex/example/phrases.txt vectrex/example/speech_data.asm
;                 (or edit and export in python vectrex/editor.py vectrex/example/phrases.txt)
;==============================================================================

; BIOS routines and variables used here
Wait_Recal      equ    $F192                  ; DP = $D0 afterwards
Do_Sound        equ    $F289                  ; DP = $D0
Read_Btns       equ    $F1BA                  ; A = buttons pressed since last time; DP = $D0
Intensity_a     equ    $F2AB
Reset0Ref       equ    $F354
Print_Str_d     equ    $F37A                  ; D = y, x position; U = the string
Vec_Music_Work  equ    $C83F                  ; the BIOS sound buffer: R13 .. R0

; The player's settings, then the player and the speech data.
VS_RAM          equ    $C880                  ; 22 bytes
VS_DUCK         equ    0                      ; this cartridge has no other sound

;--- Cartridge header ----------------------------------------------------------
        org    0
        fcc    "g GCE 2026"
        fcb    $80
        fdb    $FD0D                          ; the BIOS start-up tune
        fcb    $F8,$50,$20,-$56               ; title height, width, y, x
        fcc    "VTX SPEECH"
        fcb    $80
        fcb    0

;--- Start ---------------------------------------------------------------------
Start:
        ldx    #Vec_Music_Work                ; a silent sound buffer: volumes 0,
        ldb    #14                            ; everything off in the mixer
Clear:  clr    ,x+
        decb
        bne    Clear
        lda    #$3F
        sta    Vec_Music_Work+6               ; R7
        jsr    Speech_Init

;--- Every frame -------------------------------------------------------------------
Main:
        jsr    Speech_Wait_Recal              ; Wait_Recal that keeps speech in real time
        lda    #$5F
        jsr    Intensity_a
        jsr    Reset0Ref
        ldd    #$50C5                         ; y, x (centred)
        ldu    #Title
        jsr    Print_Str_d
        jsr    Reset0Ref
        ldd    #$10A0
        ldu    #Help
        jsr    Print_Str_d

        jsr    Read_Btns                      ; new presses: bit 0 = button 1 ...
        ldx    #Say_Game
        bita   #1
        bne    Say
        ldx    #Say_Hello
        bita   #2
        bne    Say
        ldx    #Say_Alert
        bita   #4
        bne    Say
        ldx    #Say_Taunt
        bita   #8
        beq    Sound
Say:    jsr    Speech_Say

Sound:  jsr    Speech_Service                 ; speech into the sound buffer
        jsr    Do_Sound                       ; the buffer to the AY
        bra    Main

Title:  fcc    "VTX SPEECH"
        fcb    $80
Help:   fcc    "PRESS 1 2 3 OR 4"
        fcb    $80

        include "../vtx_speech.asm"
        include "speech_data.asm"
