"""Small original scenes for regression tests and manual import checks."""

from manim import *


class Demo(MovingCameraScene):
    def construct(self):
        box = RoundedRectangle(width=3, height=1.5, corner_radius=.15,
                               fill_color=BLUE, fill_opacity=1, stroke_width=3)
        title = Text("Editable parts", font="Arial", font_size=28).next_to(box, UP)
        arrow = Arrow(LEFT*4, LEFT*1.7, color=YELLOW)
        self.play(FadeIn(box, shift=UP*.2), Write(title), GrowArrow(arrow), run_time=.6)
        self.play(box.animate.shift(RIGHT).set_color(GREEN), run_time=.7)
        self.play(self.camera.frame.animate.set(width=10).shift(RIGHT), run_time=.5)
        self.wait(.2)


class MotionFamilies(MovingCameraScene):
    def construct(self):
        square = Square(fill_opacity=1)
        circle = Circle().shift(RIGHT*3)
        self.play(FadeIn(square, shift=UP), run_time=.4)
        self.play(square.animate.shift(RIGHT).scale(.7).set_color(RED), run_time=.5, rate_func=linear)
        self.play(Indicate(square), Wiggle(circle), run_time=.5)
        self.play(Create(circle), run_time=.4)
        self.play(Flash(square), run_time=.3)
        self.play(ReplacementTransform(square, Triangle(fill_opacity=1)), run_time=.4)
        self.play(FadeOut(circle), run_time=.3)
        self.wait(.2)
