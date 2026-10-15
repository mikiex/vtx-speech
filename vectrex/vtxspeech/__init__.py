"""VTX Speech: the voice model, in Python.

A copy of the reference model from the VTX project (tools/vtx_speech:
phonemes, pronounce, voice, word_track), made self-contained: it reads the
CMU dictionary from this repository's vendor/ folder and needs nothing but
Python 3.8+. vectrex/export.py uses it to make speech data for
vectrex/vtx_speech.asm; js/speech.js is the same model in JavaScript.
"""
